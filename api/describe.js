// Vercel serverless function: the only thing that talks to Claude.
// The browser sends a cropped JPEG frame + recent descriptions; this adds the
// API key (never sent to the browser), calls the vision model, and returns
// one short description or "skip".

import Anthropic from "@anthropic-ai/sdk";
import { createHash, timingSafeEqual } from "node:crypto";

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5";

// USD per million tokens [input, output]. Used only for the on-screen cost estimate.
const PRICES = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5-5": [2, 10],
};

const MAX_IMAGE_BASE64 = 1_500_000; // ~1.1 MB JPEG; real frames are ~30-60 KB
const MAX_RECENT = 6;
const MAX_FIELD = 600;

const BASE_RULES = `You are a professional audio describer producing live audio description for a blind viewer watching TV. Each request contains one still frame of the TV picture (photographed by a phone camera, so expect some glare, blur or moiré) and the descriptions you have already given.

Rules:
- Reply with ONE description in the present tense. No preamble, no quotation marks.
- Describe only meaningful visual changes: actions, who is present or arrives or leaves, changes of setting or scene, clear facial expressions, and on-screen text such as titles, captions, signs, and phone or computer screens. Read short on-screen text word for word.
- Never describe dialogue, speech, music or sounds, and never guess what anyone is saying. Ignore subtitles of spoken dialogue.
- Never repeat or rephrase something you already described. If nothing new and important is visible, reply exactly: SKIP
- Keep character labels consistent with your earlier descriptions, e.g. "the woman in the red coat". Use a character's name only when the cast notes or on-screen text make the identification clear.
- Describe what is visible, not inner states: "she frowns", not "she is upset".
- Never mention the TV, the room, the camera, glare or picture quality. If the frame is unusable (blank, a menu, washed out by glare), reply SKIP.`;

const SYSTEM = {
  brief: `${BASE_RULES}
- Be brief: 10 words or fewer. Describe only the single most important change, and prefer SKIP for minor ones.`,
  detailed: `${BASE_RULES}
- 15 words or fewer. You may include setting details, clothing and expressions when they are new.`,
};

let client;
function getClient() {
  client ??= new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 1, // a stale description is useless, so don't retry for long
    timeout: 10_000,
  });
  return client;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function sha256(s) {
  return createHash("sha256").update(String(s ?? ""), "utf8").digest();
}

function passcodeOk(given) {
  const expected = process.env.APP_PASSCODE;
  if (!expected || !given) return false;
  return timingSafeEqual(sha256(given), sha256(expected));
}

function shortString(v, max = MAX_FIELD) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function clean(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim()
    .slice(0, 240);
}

function configured() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.APP_PASSCODE);
}

// Health check used by the app on load: is the server set up, and is the passcode right?
export function GET(request) {
  if (!configured()) return json(500, { ok: false, code: "config", error: "Server is missing ANTHROPIC_API_KEY or APP_PASSCODE." });
  if (!passcodeOk(request.headers.get("x-passcode"))) return json(401, { ok: false, code: "passcode", error: "Wrong passcode." });
  return json(200, { ok: true, model: MODEL });
}

export async function POST(request) {
  if (!configured()) {
    return json(500, { code: "config", error: "Server is missing ANTHROPIC_API_KEY or APP_PASSCODE. See the README." });
  }
  if (!passcodeOk(request.headers.get("x-passcode"))) {
    return json(401, { code: "passcode", error: "Wrong passcode." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { code: "bad_request", error: "Body must be JSON." });
  }

  const image = typeof body.image === "string" ? body.image : "";
  if (!image || image.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) {
    return json(400, { code: "bad_request", error: "Missing or oversized image." });
  }
  const recent = (Array.isArray(body.recent) ? body.recent : [])
    .slice(-MAX_RECENT)
    .map((r) => shortString(r, 240))
    .filter(Boolean);
  const title = shortString(body.title, 120);
  const characters = shortString(body.characters);
  const verbosity = body.verbosity === "detailed" ? "detailed" : "brief";

  const parts = [];
  if (title) parts.push(`Show: ${title}`);
  if (characters) parts.push(`Cast notes from the viewer's family:\n${characters}`);
  parts.push(
    recent.length
      ? `Your earlier descriptions, oldest first:\n${recent.map((r) => `- ${r}`).join("\n")}`
      : "This is the first frame of the session.",
  );
  parts.push("Describe what is new in this frame, or reply SKIP.");

  try {
    const msg = await getClient().messages.create({
      model: MODEL,
      max_tokens: 80,
      system: SYSTEM[verbosity],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: parts.join("\n\n") },
          ],
        },
      ],
    });

    const raw = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    const text = clean(raw);
    const skip = msg.stop_reason === "refusal" || !text || /^skip\b/i.test(text);

    const inTok = msg.usage?.input_tokens ?? 0;
    const outTok = msg.usage?.output_tokens ?? 0;
    const [pIn, pOut] = PRICES[MODEL] ?? PRICES["claude-haiku-4-5"];
    const costUSD = (inTok * pIn + outTok * pOut) / 1e6;

    return json(200, { text: skip ? "" : text, skip, usage: { input: inTok, output: outTok }, costUSD });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return json(500, { code: "config", error: "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in Vercel." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return json(429, { code: "rate_limited", error: "Rate limited by Anthropic." });
    }
    if (err instanceof Anthropic.BadRequestError) {
      // e.g. "credit balance is too low" — surface the reason so it can be fixed
      return json(502, { code: "upstream_400", error: `Anthropic: ${err.message}`.slice(0, 300) });
    }
    if (err instanceof Anthropic.APIError) {
      return json(502, { code: "upstream", error: `Anthropic error ${err.status ?? "(network)"}` });
    }
    return json(502, { code: "upstream", error: "Unexpected server error." });
  }
}
