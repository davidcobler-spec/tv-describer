'use strict';

// ---------- constants ----------
const OUT_W = 640;               // size of the image sent to the model (16:9)
const OUT_H = 360;
const THUMB_W = 32;              // tiny grayscale copy used to detect "nothing changed"
const THUMB_H = 18;
const JPEG_QUALITY = 0.7;
const STALE_MS = 6000;           // drop descriptions older than this (age of the frame)
const PAUSE_MS = 700;            // dialogue pause needed before speaking
const CONTEXT_COUNT = 5;         // how many earlier descriptions to send for context
const FAILURES_BEFORE_ALERT = 3;
const ALERT_REPEAT_MS = 60000;
const REQUEST_TIMEOUT_MS = 12000;
// Mean absolute grayscale difference (0-255) below which a frame counts as unchanged.
// Starting points; watch the "change" number in the stats line while tuning.
const CHANGE_THRESHOLDS = { low: 12, normal: 7, high: 4 };
// Dialogue detector: speech-band level must exceed the background by this many dB.
const VOICE_MARGIN_DB = 10;

const STORE_KEY = 'tvd.settings.v1';
const DEFAULTS = {
  passcode: '',
  interval: 4,
  verbosity: 'brief',
  rate: 1.0,
  voiceURI: '',
  output: 'speaker',
  dialogueAware: false,
  sensitivity: 'normal',
  title: '',
  characters: '',
  corners: null, // [[x,y] x4] normalized 0..1, ordered TL, TR, BR, BL
};

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const now = () => Date.now();

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

const settings = loadSettings();

const el = {
  alert: $('alert'), status: $('status'),
  startBtn: $('startBtn'), describeNowBtn: $('describeNowBtn'),
  statCalls: $('statCalls'), statCost: $('statCost'), statUnchanged: $('statUnchanged'),
  statModelSkip: $('statModelSkip'), statStale: $('statStale'), statDebug: $('statDebug'),
  transcript: $('transcript'),
  interval: $('interval'), intervalOut: $('intervalOut'),
  verbosity: $('verbosity'), rate: $('rate'), rateOut: $('rateOut'),
  voice: $('voice'), testVoiceBtn: $('testVoiceBtn'),
  output: $('output'), dialogueAware: $('dialogueAware'), dialogueNote: $('dialogueNote'),
  sensitivity: $('sensitivity'), title: $('title'), characters: $('characters'),
  videoWrap: $('videoWrap'), video: $('video'), overlay: $('overlay'),
  cameraBtn: $('cameraBtn'), cornersBtn: $('cornersBtn'), clearCornersBtn: $('clearCornersBtn'),
  cropPreview: $('cropPreview'), frameCanvas: $('frameCanvas'),
  passcode: $('passcode'), checkBtn: $('checkBtn'),
  dimBtn: $('dimBtn'), dimmer: $('dimmer'), undimBtn: $('undimBtn'),
};

const stats = { calls: 0, unchanged: 0, modelSkips: 0, stale: 0, cost: 0, lastDiff: null };

let running = false;
let inFlight = false;
let forceQueued = false;
let tickTimer = null;
let stream = null;
let wakeLock = null;
let pickingCorners = null; // array of picked points while in corner mode
let lastSentThumb = null;
let recent = [];
let consecutiveFailures = 0;
let lastAlertAt = 0;
let alertedOutage = false;

function setStatus(text) { el.status.textContent = text; }
function showAlert(text) {
  el.alert.textContent = text;
  el.alert.hidden = !text;
}

// ---------- speech ----------
let voices = [];
let speaking = false;
let speakingDeadline = 0;
let lastSpeechEnd = 0;
let pending = null; // { text, t } — single slot: a newer description replaces an older one

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices();
  const current = settings.voiceURI;
  const sorted = [...voices].sort((a, b) => {
    const ae = a.lang.startsWith('en') ? 0 : 1;
    const be = b.lang.startsWith('en') ? 0 : 1;
    return ae - be || a.name.localeCompare(b.name);
  });
  el.voice.replaceChildren(new Option('Default voice', ''));
  for (const v of sorted) {
    el.voice.add(new Option(`${v.name} (${v.lang})`, v.voiceURI, false, v.voiceURI === current));
  }
}

function currentVoice() {
  return voices.find((v) => v.voiceURI === settings.voiceURI) || null;
}

function say(text, { interrupt = false } = {}) {
  if (!('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  if (interrupt) synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = currentVoice();
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = settings.rate;
  speaking = true;
  // Safety net: iOS occasionally never fires onend.
  const words = text.split(/\s+/).length;
  speakingDeadline = now() + (words / 2.5 / settings.rate) * 1000 + 2500;
  const done = () => { speaking = false; lastSpeechEnd = now(); };
  u.onend = done;
  u.onerror = done;
  synth.speak(u);
}

function enqueueDescription(text, capturedAt) {
  pending = { text, t: capturedAt };
  pumpSpeech();
}

function pumpSpeech() {
  if (speaking && now() > speakingDeadline) speaking = false;
  if (!pending) return;
  if (now() - pending.t > STALE_MS) {
    pending = null;
    stats.stale++;
    renderStats();
    return;
  }
  if (speaking || !running) return;
  if (dialogueActive()) return; // hold until the show pauses (or the line goes stale)
  const { text } = pending;
  pending = null;
  say(text);
}
setInterval(pumpSpeech, 100);

// ---------- dialogue detection (microphone) ----------
let mic = null; // { stream, ctx, analyser, timer }
let lastVoiceAt = 0;
let noiseFloorDb = null;
let voiceNow = false;

function dialogueAllowed() {
  return settings.output === 'bluetooth';
}
function dialogueActive() {
  return Boolean(mic) && now() - lastVoiceAt < PAUSE_MS;
}

async function startMic() {
  if (mic || !settings.dialogueAware || !dialogueAllowed()) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.3;
    ctx.createMediaStreamSource(s).connect(analyser);
    const bins = new Float32Array(analyser.frequencyBinCount);
    const hzPerBin = ctx.sampleRate / analyser.fftSize;
    const lo = Math.floor(300 / hzPerBin);
    const hi = Math.ceil(3400 / hzPerBin);
    noiseFloorDb = null;
    const timer = setInterval(() => {
      analyser.getFloatFrequencyData(bins);
      let power = 0;
      for (let i = lo; i <= hi; i++) power += Math.pow(10, bins[i] / 10);
      const level = 10 * Math.log10(power / (hi - lo + 1) + 1e-12);
      // Background tracker: drops instantly to quieter levels, creeps up 1 dB/s.
      noiseFloorDb = noiseFloorDb === null ? level : Math.min(level, noiseFloorDb + 0.05);
      voiceNow = level > noiseFloorDb + VOICE_MARGIN_DB;
      // Ignore our own voice (e.g. a Bluetooth speaker near the phone).
      const ownSpeech = speaking || now() - lastSpeechEnd < 300;
      if (voiceNow && !ownSpeech) lastVoiceAt = now();
    }, 50);
    mic = { stream: s, ctx, timer };
    setAudioSession('play-and-record');
  } catch (err) {
    settings.dialogueAware = false;
    el.dialogueAware.checked = false;
    saveSettings();
    showAlert('Microphone unavailable, so descriptions will not wait for pauses. ' + permissionHint(err, 'Microphone'));
  }
}

function stopMic() {
  if (!mic) return;
  clearInterval(mic.timer);
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.ctx.close().catch(() => {});
  mic = null;
  lastVoiceAt = 0;
  setAudioSession('playback');
}

// Safari 17+: 'playback' lets speech play even with the ring/silent switch on.
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* unsupported */ }
}

function updateDialogueUi() {
  const allowed = dialogueAllowed();
  el.dialogueAware.disabled = !allowed;
  if (!allowed) {
    el.dialogueAware.checked = false;
    el.dialogueNote.textContent = 'Off while using the phone speaker: the microphone would hear the descriptions themselves.';
  } else {
    el.dialogueAware.checked = settings.dialogueAware;
    el.dialogueNote.textContent = 'Holds each description until the show goes quiet for about 0.7 s. Continuous music can count as talking.';
  }
}

// ---------- camera ----------
function permissionHint(err, what) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `${what} permission was denied. On iPhone: tap "aA" in the Safari address bar, then Website Settings, set ${what} to Allow, and reload. Or Settings > Apps > Safari > ${what}.`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${what.toLowerCase()} was found.`;
  if (name === 'NotReadableError') return `The ${what.toLowerCase()} is in use by another app. Close it and try again.`;
  return `${what} error: ${(err && err.message) || name || 'unknown'}.`;
}

async function startCamera() {
  if (stream && stream.getVideoTracks().some((t) => t.readyState === 'live')) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showAlert('This browser cannot use the camera. Open the page in Safari or Chrome over https.');
    return false;
  }
  try {
    // Captured larger than we send so the cropped TV area stays sharp
    // (on-screen text is the first thing to suffer from a small crop).
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    stream = null;
    const msg = 'Camera unavailable. ' + permissionHint(err, 'Camera');
    showAlert(msg);
    say(msg, { interrupt: true });
    return false;
  }
  el.video.srcObject = stream;
  await el.video.play().catch(() => {});
  await new Promise((resolve) => {
    if (el.video.videoWidth) return resolve();
    el.video.addEventListener('loadedmetadata', resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  el.cameraBtn.textContent = 'Camera is on';
  drawOverlay();
  startPreviewLoop();
  return true;
}

// ---------- corners & perspective warp ----------
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  // Sorting by angle around the center gives TL, TR, BR, BL (y points down).
  return [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

function solveLinear(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-10) throw new Error('degenerate corners');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

// Homography mapping output pixel (u,v) -> source pixel (x,y).
function homography(dst, src) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i];
    const [x, y] = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return solveLinear(A, b);
}

function warp(src, sw, sh, H, out, ow, oh) {
  const d = out.data;
  let i = 0;
  const maxX = sw - 1.001;
  const maxY = sh - 1.001;
  for (let v = 0; v < oh; v++) {
    const vv = v + 0.5;
    for (let u = 0; u < ow; u++) {
      const uu = u + 0.5;
      const w = H[6] * uu + H[7] * vv + 1;
      let x = (H[0] * uu + H[1] * vv + H[2]) / w - 0.5;
      let y = (H[3] * uu + H[4] * vv + H[5]) / w - 0.5;
      if (x < 0) x = 0; else if (x > maxX) x = maxX;
      if (y < 0) y = 0; else if (y > maxY) y = maxY;
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const p = (y0 * sw + x0) * 4;
      const q = p + sw * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[p + c] + (src[p + 4 + c] - src[p + c]) * fx;
        const bot = src[q + c] + (src[q + 4 + c] - src[q + c]) * fx;
        d[i + c] = top + (bot - top) * fy;
      }
      d[i + 3] = 255;
      i += 4;
    }
  }
}

const thumbCanvas = document.createElement('canvas');
thumbCanvas.width = THUMB_W;
thumbCanvas.height = THUMB_H;
const outCanvas = el.cropPreview; // the visible preview doubles as the output buffer

// Grab the current camera frame, crop/straighten it to the TV, return JPEG + thumbnail.
function captureFrame() {
  const v = el.video;
  const sw = v.videoWidth;
  const sh = v.videoHeight;
  if (!sw || !sh) return null;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  const corners = settings.corners;
  if (corners) {
    const fc = el.frameCanvas;
    if (fc.width !== sw || fc.height !== sh) { fc.width = sw; fc.height = sh; }
    const fctx = fc.getContext('2d', { willReadFrequently: true });
    fctx.drawImage(v, 0, 0, sw, sh);
    const src = fctx.getImageData(0, 0, sw, sh).data;
    const srcPts = corners.map(([x, y]) => [x * sw, y * sh]);
    const dstPts = [[0, 0], [OUT_W, 0], [OUT_W, OUT_H], [0, OUT_H]];
    let H;
    try { H = homography(dstPts, srcPts); } catch { H = null; }
    if (H) {
      const out = outCtx.createImageData(OUT_W, OUT_H);
      warp(src, sw, sh, H, out, OUT_W, OUT_H);
      outCtx.putImageData(out, 0, 0);
    } else {
      outCtx.drawImage(v, 0, 0, OUT_W, OUT_H);
    }
  } else {
    // No crop set: send the whole camera frame, letterboxed into 16:9.
    outCtx.fillStyle = '#000';
    outCtx.fillRect(0, 0, OUT_W, OUT_H);
    const scale = Math.min(OUT_W / sw, OUT_H / sh);
    const w = sw * scale;
    const h = sh * scale;
    outCtx.drawImage(v, (OUT_W - w) / 2, (OUT_H - h) / 2, w, h);
  }
  const tctx = thumbCanvas.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(outCanvas, 0, 0, THUMB_W, THUMB_H);
  const td = tctx.getImageData(0, 0, THUMB_W, THUMB_H).data;
  const thumb = new Uint8Array(THUMB_W * THUMB_H);
  for (let i = 0, j = 0; j < thumb.length; i += 4, j++) {
    thumb[j] = (td[i] * 77 + td[i + 1] * 150 + td[i + 2] * 29) >> 8;
  }
  return { thumb, t: now(), jpeg: () => outCanvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1] };
}

function frameDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function drawOverlay() {
  const c = el.overlay;
  const rect = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(rect.width * dpr);
  c.height = Math.round(rect.height * dpr);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const pts = pickingCorners || settings.corners;
  if (!pts || !pts.length) return;
  ctx.strokeStyle = '#ffd400';
  ctx.fillStyle = '#ffd400';
  ctx.lineWidth = 3 * dpr;
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    const px = x * c.width;
    const py = y * c.height;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  if (pts.length === 4) ctx.closePath();
  ctx.stroke();
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.arc(x * c.width, y * c.height, 8 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
}

let previewTimer = null;
function startPreviewLoop() {
  if (previewTimer) return;
  // While not describing, refresh the crop preview once a second (no API calls).
  previewTimer = setInterval(() => { if (!running) captureFrame(); }, 1000);
}

// ---------- API ----------
async function api(method, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch('/api/describe', {
      method,
      headers: { 'content-type': 'application/json', 'x-passcode': settings.passcode },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- the description loop ----------
function scheduleTick(delayMs) {
  clearTimeout(tickTimer);
  if (!running) return;
  tickTimer = setTimeout(() => tick(false), delayMs ?? settings.interval * 1000);
}

async function tick(force) {
  if (!force && !running) return;
  if (inFlight) {
    if (force) forceQueued = true;
    return;
  }
  const frame = captureFrame();
  if (!frame) {
    scheduleTick();
    return;
  }
  if (!force && lastSentThumb) {
    const d = frameDiff(frame.thumb, lastSentThumb);
    stats.lastDiff = d;
    if (d < CHANGE_THRESHOLDS[settings.sensitivity]) {
      stats.unchanged++;
      renderStats();
      scheduleTick();
      return;
    }
  }

  inFlight = true;
  stats.calls++;
  renderStats();
  let retrySoon = false;
  try {
    const data = await api('POST', {
      image: frame.jpeg(),
      recent: recent.slice(-CONTEXT_COUNT),
      title: settings.title,
      characters: settings.characters,
      verbosity: settings.verbosity,
    });
    lastSentThumb = frame.thumb; // only after success, so failures retry on the next tick
    stats.cost += data.costUSD || 0;
    onSuccess();
    if (data.skip) {
      stats.modelSkips++;
      if (force) say('Nothing new.', { interrupt: true });
    } else {
      recent.push(data.text);
      if (recent.length > 10) recent = recent.slice(-10);
      addTranscript(data.text);
      if (force) say(data.text, { interrupt: true });
      else enqueueDescription(data.text, frame.t);
    }
  } catch (err) {
    retrySoon = onFailure(err);
  } finally {
    inFlight = false;
    renderStats();
    if (forceQueued) {
      forceQueued = false;
      tick(true);
    } else {
      scheduleTick(retrySoon ? 1000 : undefined);
    }
  }
}

function onSuccess() {
  if (consecutiveFailures >= FAILURES_BEFORE_ALERT || alertedOutage) {
    if (alertedOutage) say('Descriptions are back.');
    showAlert('');
  }
  consecutiveFailures = 0;
  alertedOutage = false;
  if (running) setStatus('Describing.');
}

// Returns true if a quick silent retry is worthwhile.
function onFailure(err) {
  if (err.status === 401 || err.code === 'config') {
    const msg = err.status === 401
      ? 'Wrong passcode. Descriptions stopped. Enter the passcode in Settings.'
      : `Server setup problem: ${err.message}`;
    stop({ silent: true });
    showAlert(msg);
    say(msg, { interrupt: true });
    return false;
  }
  consecutiveFailures++;
  setStatus(`Retrying (${err.message}).`);
  if (consecutiveFailures >= FAILURES_BEFORE_ALERT) {
    showAlert(`Having trouble reaching the description service: ${err.message}`);
    if (now() - lastAlertAt > ALERT_REPEAT_MS) {
      lastAlertAt = now();
      alertedOutage = true;
      pending = null;
      say('Audio description is having trouble connecting.', { interrupt: true });
    }
  }
  return consecutiveFailures === 1; // one quick retry, then fall back to the normal pace
}

// ---------- wake lock ----------
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    setStatus('Describing. This browser cannot keep the screen on: set Auto-Lock to Never.');
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    setStatus('Describing. Could not keep the screen awake: set Auto-Lock to Never.');
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !running) return;
  // iOS stops the camera when the page is hidden; bring everything back.
  await startCamera();
  if (!wakeLock) acquireWakeLock();
});

// ---------- start / stop ----------
async function start() {
  if (running) return;
  if (!settings.passcode) {
    showAlert('Enter the passcode in the Access section first.');
    el.passcode.focus();
    return;
  }
  showAlert('');
  // Speaking inside the tap "unlocks" speech on iOS, and confirms to the listener.
  setAudioSession('playback');
  say('Starting descriptions.', { interrupt: true });
  if (!(await startCamera())) return;
  running = true;
  el.startBtn.textContent = 'Pause';
  el.startBtn.setAttribute('aria-pressed', 'true');
  setStatus('Describing.');
  acquireWakeLock();
  await startMic();
  lastSentThumb = null;
  scheduleTick(500);
}

function stop({ silent = false } = {}) {
  running = false;
  clearTimeout(tickTimer);
  pending = null;
  stopMic();
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
  el.startBtn.textContent = 'Start';
  el.startBtn.setAttribute('aria-pressed', 'false');
  setStatus('Paused.');
  if (!silent) say('Paused.', { interrupt: true });
}

// ---------- UI ----------
function renderStats() {
  el.statCalls.textContent = String(stats.calls);
  el.statCost.textContent = `$${stats.cost.toFixed(stats.cost < 1 ? 3 : 2)}`;
  el.statUnchanged.textContent = String(stats.unchanged);
  el.statModelSkip.textContent = String(stats.modelSkips);
  el.statStale.textContent = String(stats.stale);
  const parts = [];
  if (stats.lastDiff !== null) parts.push(`change ${stats.lastDiff.toFixed(1)} (threshold ${CHANGE_THRESHOLDS[settings.sensitivity]})`);
  if (mic) parts.push(voiceNow ? 'TV speech: yes' : 'TV speech: no');
  el.statDebug.textContent = parts.join(' · ');
}
setInterval(() => { if (mic) renderStats(); }, 250);

function addTranscript(text) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  const d = new Date();
  time.dateTime = d.toISOString();
  time.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  li.append(time, document.createTextNode(text));
  el.transcript.prepend(li);
  while (el.transcript.children.length > 100) el.transcript.lastElementChild.remove();
}

function bindSettings() {
  el.interval.value = settings.interval;
  el.intervalOut.textContent = settings.interval;
  el.verbosity.value = settings.verbosity;
  el.rate.value = settings.rate;
  el.rateOut.textContent = Number(settings.rate).toFixed(1);
  el.output.value = settings.output;
  el.sensitivity.value = settings.sensitivity;
  el.title.value = settings.title;
  el.characters.value = settings.characters;
  el.passcode.value = settings.passcode;
  updateDialogueUi();

  el.interval.addEventListener('input', () => {
    settings.interval = Number(el.interval.value);
    el.intervalOut.textContent = settings.interval;
    saveSettings();
  });
  el.interval.addEventListener('change', () => { if (running && !inFlight) scheduleTick(); });
  el.verbosity.addEventListener('change', () => { settings.verbosity = el.verbosity.value; saveSettings(); });
  el.rate.addEventListener('input', () => {
    settings.rate = Number(el.rate.value);
    el.rateOut.textContent = settings.rate.toFixed(1);
    saveSettings();
  });
  el.voice.addEventListener('change', () => { settings.voiceURI = el.voice.value; saveSettings(); });
  el.testVoiceBtn.addEventListener('click', () => say('The woman in the red coat opens the door.', { interrupt: true }));
  el.output.addEventListener('change', async () => {
    settings.output = el.output.value;
    if (!dialogueAllowed()) { settings.dialogueAware = false; stopMic(); }
    saveSettings();
    updateDialogueUi();
  });
  el.dialogueAware.addEventListener('change', async () => {
    settings.dialogueAware = el.dialogueAware.checked && dialogueAllowed();
    saveSettings();
    if (settings.dialogueAware && running) await startMic();
    if (!settings.dialogueAware) stopMic();
  });
  el.sensitivity.addEventListener('change', () => { settings.sensitivity = el.sensitivity.value; saveSettings(); renderStats(); });
  el.title.addEventListener('change', () => { settings.title = el.title.value.trim(); saveSettings(); recent = []; });
  el.characters.addEventListener('change', () => { settings.characters = el.characters.value.trim(); saveSettings(); });
  el.passcode.addEventListener('change', () => { settings.passcode = el.passcode.value.trim(); saveSettings(); });
}

function bindControls() {
  el.startBtn.addEventListener('click', () => (running ? stop() : start()));

  el.describeNowBtn.addEventListener('click', async () => {
    if (!settings.passcode) {
      showAlert('Enter the passcode in the Access section first.');
      el.passcode.focus();
      return;
    }
    say('Looking.', { interrupt: true });
    if (!(await startCamera())) return;
    pending = null;
    tick(true);
  });

  el.cameraBtn.addEventListener('click', () => startCamera());

  el.cornersBtn.addEventListener('click', async () => {
    if (!(await startCamera())) return;
    pickingCorners = [];
    el.videoWrap.classList.add('picking');
    el.videoWrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setStatus('Tap corner 1 of 4 of the TV picture.');
    drawOverlay();
  });

  el.clearCornersBtn.addEventListener('click', () => {
    settings.corners = null;
    pickingCorners = null;
    el.videoWrap.classList.remove('picking');
    saveSettings();
    drawOverlay();
    lastSentThumb = null;
    setStatus('Corners cleared. The whole camera view will be sent.');
  });

  el.overlay.addEventListener('pointerdown', (e) => {
    if (!pickingCorners) return;
    e.preventDefault();
    const rect = el.overlay.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    pickingCorners.push([x, y]);
    if (pickingCorners.length < 4) {
      setStatus(`Tap corner ${pickingCorners.length + 1} of 4.`);
    } else {
      settings.corners = orderCorners(pickingCorners);
      pickingCorners = null;
      el.videoWrap.classList.remove('picking');
      saveSettings();
      lastSentThumb = null;
      captureFrame();
      setStatus('TV corners saved. Check the cropped preview below.');
    }
    drawOverlay();
  });

  el.checkBtn.addEventListener('click', async () => {
    settings.passcode = el.passcode.value.trim();
    saveSettings();
    setStatus('Checking…');
    try {
      const data = await api('GET');
      showAlert('');
      setStatus(`Connected. Model: ${data.model}.`);
      say('Connected.', { interrupt: true });
    } catch (err) {
      const msg = err.status === 401 ? 'Wrong passcode.' : `Not connected: ${err.message}`;
      showAlert(msg);
      setStatus('');
      say(msg, { interrupt: true });
    }
  });

  el.dimBtn.addEventListener('click', () => {
    el.dimmer.hidden = false;
    el.undimBtn.focus();
  });
  el.undimBtn.addEventListener('click', () => {
    el.dimmer.hidden = true;
    el.dimBtn.focus();
  });

  window.addEventListener('resize', drawOverlay);
  el.video.addEventListener('loadedmetadata', drawOverlay);
}

// ---------- boot ----------
bindSettings();
bindControls();
renderStats();
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
} else {
  showAlert('This browser has no built-in speech, so descriptions will only appear as text.');
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
