# TV Describer

A phone on a stand watches the TV through its rear camera. Every few seconds it
sends a cropped frame to Claude (Haiku 4.5), gets back a short present-tense
description of what changed on screen, and speaks it aloud. It's built for a
blind or visually impaired viewer.

```
phone (index.html + app.js)                    Vercel function (api/describe.js)
 camera → crop/straighten → "did it change?" ──►  checks passcode, adds API key,
 speechSynthesis ◄── one line or "skip" ◄───────  calls Claude, returns text + cost
```

No framework and no build step. There is one runtime dependency
(`@anthropic-ai/sdk`, server side only).

## Files

| Path | What it is |
|---|---|
| `public/index.html`, `app.js`, `styles.css` | The whole app (camera, crop, change detection, speech, settings) |
| `public/sw.js`, `manifest.webmanifest`, icons | Makes it installable ("Add to Home Screen") |
| `api/describe.js` | Serverless proxy. The only code that holds the API key |
| `vercel.json` | Serves `public/`, sets camera/mic permission headers |
| `tools/dev-server.mjs` | Local server for testing without Vercel |
| `tools/make-icons.mjs` | Regenerates the icons |

## Environment variables (set in Vercel → Project → Settings → Environment Variables)

| Name | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Your Claude API key. Never sent to the browser. |
| `APP_PASSCODE` | yes | Typed once into the app on each phone. Blocks strangers from using your key. |
| `CLAUDE_MODEL` | no | Defaults to `claude-haiku-4-5`. |

**After changing any variable, redeploy** (Deployments → ⋯ → Redeploy). Running deployments don't pick up changes.

## Getting an API key

1. Go to <https://console.anthropic.com> and sign in or create an account.
2. **Billing**: add a payment method and buy credits ($5 is plenty to start).
3. **Limits**: set a monthly spend limit (e.g. $10). This is your hard backstop on cost.
4. **API Keys → Create Key**. Name it `tv-describer` and copy it. It's shown only once.
5. Paste it into Vercel as `ANTHROPIC_API_KEY`, then redeploy.

## Deploying

The Vercel project `tv-describer` is connected to this GitHub repo: **every push to `main`
deploys to production automatically** (other branches get preview deployments).
To deploy by hand instead: `npm i -g vercel && vercel link && vercel --prod`.

Deployment protection: Vercel's login wall ("Vercel Authentication") is limited to
preview deployments, so the production URL opens on any phone. Anyone can load
the page, but only someone with the passcode can make API calls.

## Local testing

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... APP_PASSCODE=test node tools/dev-server.mjs
# open http://localhost:3000 (desktop browsers allow the camera on localhost)
```

Phones need HTTPS for the camera, so test on the phone with the deployed URL.

## Using it on the iPhone

1. Open the URL in **Safari**. Share button → **Add to Home Screen**, then launch it from there.
2. Enter the passcode under **Access** and tap **Check connection**. It should say "Connected".
3. Tap **Set TV corners**, then tap the 4 corners of the TV picture in the camera view.
   Check the "What gets sent" preview: it should show just the TV picture, square-on.
4. Press **Start**. You'll hear "Starting descriptions."
5. Optionally fill in the show title and characters (e.g. `Bluey - blue heeler puppy`).
   This helps the model name people consistently.

iOS asks for camera permission on first use, and may ask again after the app has
been closed for a while. That's normal for web apps.

## How it decides what to say

- **Change check (the main cost control):** each frame is shrunk to 32×18 grayscale
  and compared with the last frame that was actually sent. If the average change is
  below the threshold, no API call is made. The stats line shows the live "change"
  number. Use the **Skip unchanged frames** setting to tune it.
- **The model** gets the frame plus its last 5 descriptions. It answers with one line
  (10 words max on Brief, 15 on Detailed) or `SKIP`.
- **Speech never backs up:** there's a single slot for the next line. A newer description
  replaces an unspoken older one, and anything from a frame more than 6 seconds old is dropped.
- **Dialogue-aware mode** (Bluetooth output only): the mic listens for speech-band sound
  and holds each description until about 0.7 s of quiet. A held line that goes stale is dropped.
  It's disabled on the phone speaker because the mic would hear the descriptions themselves.
  It's experimental: continuous music or background noise can look like talking.
- **Failures:** retried silently. After 3 failures in a row it says "Audio description is
  having trouble connecting" (at most once a minute), then "Descriptions are back" when it recovers.
  A wrong passcode or a missing key stops the session and says why.

## Cost

A 640×360 frame is about 300 image tokens. With the prompt and context, each call
comes to about 600–900 input tokens and 15 output tokens: roughly **$0.001 per call**
on Haiku 4.5 ($1 / $5 per million tokens). Worst case at one call every 4 s is about
$0.90/hour. In practice the change check and SKIPs should bring that well below.
The in-app counter shows the real figure from token usage. Treat it as an estimate;
the Console's Usage page is authoritative.

## Living-room test checklist

**Mounting and angle**
- [ ] Phone is held rigidly (stand or clamp). Any wobble makes every frame "changed", which means more calls.
- [ ] Camera is as square-on to the TV as possible: centered and at screen height. The corner crop corrects moderate angles, but steep ones blur text.
- [ ] The TV fills as much of the camera view as possible. 1.5–3 m from a 55" TV is a good start.
- [ ] Phone is charging. Camera + screen + network for a whole film drains the battery.

**Glare and lighting**
- [ ] No lamp or window reflected in the TV from the phone's position. Check the crop preview, and move the phone or the lamp.
- [ ] Room lighting stays steady. A lamp switched on or off changes the whole frame and costs a call. That's harmless but worth knowing.
- [ ] Moiré (rippling stripes) in the preview: move the phone slightly closer or farther. Some moiré is fine.
- [ ] Very bright scenes aren't washed out in the preview. If they are, lower the TV's backlight or brightness a bit.

**Crop**
- [ ] After setting the corners, the preview shows only the picture, with no bezel or wall. Redo the corners whenever the phone or stand moves.

**Audio**
- [ ] "Test voice" is clearly audible from your daughter's seat at normal TV volume.
- [ ] On iPhone: if nothing is heard, check the silent switch and the media volume (not the ringer).
- [ ] Voice speed is set so lines finish before the next one is due.

**Behaviour over 15 minutes**
- [ ] Watch the stats: unchanged frames skipped should be well above zero during talky scenes.
- [ ] "Dropped as stale" stays low. If it's high, lengthen the interval or switch to Brief.
- [ ] The screen never locks. If it does, set Settings → Display & Brightness → Auto-Lock → Never for the session.
- [ ] Use "Dim screen" to cut the light from the phone during the show.
