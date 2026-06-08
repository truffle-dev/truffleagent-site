// Shared helpers for /lens/ Pages Functions.
// Imports work across functions/api/lens/* and functions/i/*.

export type LensEnv = {
  DB: D1Database;
  LENS_BUCKET: R2Bucket;
  LUMA_AGENTS_API_KEY: string;
  OPENAI_API_KEY: string;
  VISITOR_HASH_SALT: string;
};

export type LumaState = "queued" | "processing" | "completed" | "failed";

export type LumaGeneration = {
  id: string;
  state: LumaState;
  output: { type: "image"; url: string }[] | null;
  failure_reason: string | null;
  failure_code: string | null;
  model: string;
  created_at: string;
};

export type StyleHint =
  | "cinematic"
  | "whimsical"
  | "portrait"
  | "landscape"
  | "abstract"
  | "auto";

export type AspectRatio =
  | "16:9"
  | "9:16"
  | "1:1"
  | "3:2"
  | "2:3"
  | "2:1"
  | "1:2"
  | "3:1"
  | "1:3";

export type LumaModel = "uni-1" | "uni-1-max";

// Soft cost in micros (per Luma pricing). uni-1 = $0.0404, uni-1-max = $0.10.
export const COST_MICROS: Record<LumaModel, number> = {
  "uni-1": 40400,
  "uni-1-max": 100000,
};

// Per-visitor-hash daily quota. Generous enough for play, tight enough to
// prevent any one IP from racking up the bill.
export const DAILY_QUOTA = 20;

// Soft limit on the raw prompt the visitor typed.
export const MAX_RAW_PROMPT_CHARS = 600;

export const VALID_ASPECTS: AspectRatio[] = ["16:9", "9:16", "1:1", "3:2", "2:3"];
export const VALID_STYLES: StyleHint[] = [
  "cinematic",
  "whimsical",
  "portrait",
  "landscape",
  "abstract",
  "auto",
];
export const VALID_MODELS: LumaModel[] = ["uni-1", "uni-1-max"];

const LUMA_BASE = "https://agents.lumalabs.ai/v1";
const ULID_ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";

// short, sortable, URL-safe id. Format: lg_<20 chars>. Time-prefixed so
// recent generations cluster lexicographically, but we use a created_at
// DESC index in D1 for ordering — the id sort is a tiebreak.
export function newLensId(): string {
  const t = Date.now().toString(36);
  let rand = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ULID_ALPHA[b % ULID_ALPHA.length];
  return `lg_${t}${rand}`.slice(0, 24);
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// Stable per-visitor hash from IP + day + salt. We never persist the IP.
// Rotating every day keeps the data minimal; quota windows are 24h.
export async function visitorHash(req: Request, env: LensEnv): Promise<string> {
  const ip =
    req.headers.get("CF-Connecting-IP") ??
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "0.0.0.0";
  return sha256Hex(`${ip}|${utcDay()}|${env.VISITOR_HASH_SALT}`);
}

// JSON Response helper that always sets Content-Type and no-cache.
export function jsonResponse(obj: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(obj), { ...init, headers });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ ok: false, error: { code, message } }, { status });
}

// ---------- OpenAI: moderation + enhancement ----------

// Returns true if the content is flagged. We pass when in doubt; the
// downstream Luma side and the post-generation visibility flag are the
// real safety nets.
export async function moderationFlagged(text: string, env: LensEnv): Promise<{ flagged: boolean; reason: string | null }> {
  const r = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
  });
  if (!r.ok) {
    // Fail-open: if moderation API errors, allow but log shape.
    console.error(`moderation failed ${r.status}`);
    return { flagged: false, reason: null };
  }
  const json = (await r.json()) as { results?: Array<{ flagged: boolean; categories?: Record<string, boolean> }> };
  const result = json.results?.[0];
  if (!result?.flagged) return { flagged: false, reason: null };
  const cats = result.categories ?? {};
  const top = Object.entries(cats).find(([, v]) => v === true)?.[0] ?? "policy";
  return { flagged: true, reason: top };
}

// Enhancer system prompt — mirror of the truffle-enhance-prompt CLI so the
// two paths produce coherent output regardless of which side runs them.
// (Cheema's preference: Claude Haiku for blog tooling; OpenAI on the edge
// for sub-second TTFB on the public /lens/ flow.)
const ENHANCER_SYSTEM = `You are an image-prompt enhancer for Luma Labs' uni-1 model.

Your job: take a short user prompt and rewrite it as a single dense English sentence (or two at most) that an image model can render beautifully. Output the rewritten prompt only — no preamble, no quotes, no markdown, no labels.

Anatomy of a great prompt:
  subject (who or what), action (what they are doing), scene (where + when),
  style (photographic, illustrative, cinematic, painterly), lighting (warm tungsten, blue hour, hard rim, soft north window, neon), lens or framing (wide cinematic, 50mm, macro, fish-eye), mood (joyful, melancholy, serene, electric).

Rules:
  1. Keep the user's core subject and intent. Do not replace their concept with a generic one.
  2. Add concrete sensory detail. Specific nouns and verbs beat adjectives.
  3. Include exactly one lighting cue and exactly one lens/framing cue.
  4. Include a mood word.
  5. Avoid: brand names, real people's names, NSFW, gore, hate, copyrighted characters, text-in-image instructions, generic intensifiers, AI-art clichés ("trending on artstation", "8k").
  6. If the user prompt requests violence, sexual content, named real person, or recognizable brand mascot, output exactly: BLOCKED: <one-sentence reason>.
  7. Length: 40-90 words, single paragraph. No newlines.
  8. Do not include the aspect ratio, model name, or technical Luma parameters.

Style hint matters when provided:
  cinematic — wide frame, color palette by reference DOP (Deakins, Lubezki), filmic.
  whimsical — surreal juxtaposition, playful, never edgy, never dark.
  portrait — single subject, close to medium framing, intentional light source.
  landscape — wide framing, no people unless metaphorical, atmospheric.
  abstract — texture, color, form; avoid recognizable objects.
  auto — pick the most flattering interpretation of the user prompt.`;

export async function enhancePromptOpenAI(
  raw: string,
  style: StyleHint,
  aspect: AspectRatio,
  model: LumaModel,
  env: LensEnv,
): Promise<{ enhanced: string | null; blocked: boolean; blockReason: string | null }> {
  const user = [
    `Raw prompt: ${raw}`,
    `Style hint: ${style}`,
    `Aspect ratio (context only): ${aspect}`,
    `Target model (context only): ${model}`,
  ].join("\n");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 220,
      messages: [
        { role: "system", content: ENHANCER_SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`enhancer openai ${r.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw_text = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!raw_text) {
    throw new Error("enhancer returned empty content");
  }
  // Strip a stray "Enhanced prompt:" / "Prompt:" label if the model added one.
  let text = raw_text.replace(/^(?:enhanced prompt|prompt|output|result)\s*:\s*/i, "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();

  if (text.startsWith("BLOCKED:")) {
    return { enhanced: null, blocked: true, blockReason: text.slice("BLOCKED:".length).trim() };
  }
  return { enhanced: text, blocked: false, blockReason: null };
}

// ---------- Luma ----------

export async function lumaSubmit(
  enhanced: string,
  aspect: AspectRatio,
  model: LumaModel,
  env: LensEnv,
): Promise<LumaGeneration> {
  const r = await fetch(`${LUMA_BASE}/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LUMA_AGENTS_API_KEY}`,
    },
    body: JSON.stringify({
      type: "image",
      model,
      prompt: enhanced,
      aspect_ratio: aspect,
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`luma submit ${r.status}: ${detail.slice(0, 200)}`);
  }
  return (await r.json()) as LumaGeneration;
}

export async function lumaGet(lumaId: string, env: LensEnv): Promise<LumaGeneration> {
  const r = await fetch(`${LUMA_BASE}/generations/${lumaId}`, {
    headers: { Authorization: `Bearer ${env.LUMA_AGENTS_API_KEY}` },
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`luma get ${r.status}: ${detail.slice(0, 200)}`);
  }
  return (await r.json()) as LumaGeneration;
}

// Download Luma's presigned URL into an ArrayBuffer (small enough for memory).
export async function fetchLumaImage(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`luma download ${r.status}`);
  const bytes = await r.arrayBuffer();
  const contentType = r.headers.get("content-type") ?? "image/png";
  return { bytes, contentType };
}

// ---------- D1 quota ----------

// Atomic-ish quota check. We read, increment, return.
// Race-condition tolerable: worst case one extra image lands above quota.
export async function checkAndIncrementQuota(
  env: LensEnv,
  visitor: string,
): Promise<{ remaining: number; over: boolean }> {
  const day = utcDay();
  const row = await env.DB
    .prepare("SELECT count FROM lens_daily_quota WHERE visitor_hash=? AND day=?")
    .bind(visitor, day)
    .first<{ count: number }>();
  const current = row?.count ?? 0;
  if (current >= DAILY_QUOTA) return { remaining: 0, over: true };
  await env.DB
    .prepare(
      `INSERT INTO lens_daily_quota (visitor_hash, day, count) VALUES (?, ?, 1)
       ON CONFLICT (visitor_hash, day) DO UPDATE SET count = count + 1`,
    )
    .bind(visitor, day)
    .run();
  return { remaining: DAILY_QUOTA - current - 1, over: false };
}
