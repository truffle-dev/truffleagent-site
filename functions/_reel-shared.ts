// Shared helpers for /reel/ Pages Functions.
// Mirrors functions/_lens-shared.ts but for Reel's multi-frame pipeline.
// The cron expands this file as endpoints land.

export type ReelEnv = {
  DB: D1Database;
  REEL_BUCKET: R2Bucket;
  LENS_BUCKET: R2Bucket;
  LUMA_AGENTS_API_KEY: string;
  // Reel calls Claude Opus 4.7 for character + story enhancement AND for
  // multimodal frame inspection through a long-lived Bun bridge that
  // subprocess-spawns the local `claude` CLI. Operator durable rule
  // (2026-06-08): no ANTHROPIC_API_KEY and no OPENAI_API_KEY anywhere
  // in Reel — Claude (via bridge) + Luma only. Bridge URL and bearer
  // token shipped via wrangler pages secret.
  REEL_BRIDGE_URL: string;
  REEL_BRIDGE_TOKEN: string;
  VISITOR_HASH_SALT: string;
  // Shared secret for /api/reel/admin/* endpoints. Set via
  // `wrangler pages secret put REEL_ADMIN_SECRET`. When absent the
  // admin endpoint returns 503 — never bypass.
  REEL_ADMIN_SECRET?: string;
  // Cloudflare Turnstile keys. When the secret is absent the verify call
  // falls through (test-key always-pass mode); production binding via
  // `wrangler pages secret put TURNSTILE_SECRET_KEY` swaps in the real
  // key without any code change. The site key is a plain (non-secret)
  // var; ship `TURNSTILE_SITE_KEY` via `wrangler pages env put` or just
  // hardcode in the page when convenient.
  TURNSTILE_SECRET_KEY?: string;
  // ElevenLabs API key for Phase 2 voice narration. When absent the
  // synthesize-narration endpoint returns 503. Provision via
  // `wrangler pages secret put ELEVENLABS_API_KEY`.
  ELEVENLABS_API_KEY?: string;
};

// Voice catalog for narration. Curated for cartoonish, fun storytelling.
// Default is Jessica (playful, bright, warm); the others give variety.
// Each entry's voice_id is a known ElevenLabs premade voice.
export type ReelVoice = {
  id: string;
  voice_id: string;
  label: string;
  blurb: string;
};

export const REEL_VOICES: ReelVoice[] = [
  {
    id: "jessica",
    voice_id: "cgSgspJ2msm6clMCkdW9",
    label: "Jessica",
    blurb: "Playful, bright, warm",
  },
  {
    id: "callum",
    voice_id: "N2lVS1w4EtoT3dr4eOWO",
    label: "Callum",
    blurb: "Husky trickster — cartoon mischief",
  },
  {
    id: "charlie",
    voice_id: "IKne3meq5aSn9XLyUdCD",
    label: "Charlie",
    blurb: "Hyped Australian storyteller",
  },
  {
    id: "laura",
    voice_id: "FGY2WhTYpPnrIDTdsKH5",
    label: "Laura",
    blurb: "Quirky, sassy narrator",
  },
];

export const REEL_DEFAULT_VOICE_ID = "jessica";

export function resolveVoice(id: string | null | undefined): ReelVoice | null {
  if (!id) return null;
  return REEL_VOICES.find((v) => v.id === id) ?? null;
}

// Cloudflare Turnstile sentinel test keys (per the public docs at
// developers.cloudflare.com/turnstile/troubleshooting/testing). These
// always pass; ship-time swap installs the real keys via env bindings.
export const TURNSTILE_SITE_KEY_TEST_PASS = "1x00000000000000000000AA";
export const TURNSTILE_SECRET_KEY_TEST_PASS = "1x0000000000000000000000000000000AA";

export async function verifyTurnstile(
  token: string,
  remoteIp: string | null,
  env: { TURNSTILE_SECRET_KEY?: string },
): Promise<{ success: boolean; reason: string | null }> {
  if (!token) return { success: false, reason: "missing_token" };
  const secret = env.TURNSTILE_SECRET_KEY ?? TURNSTILE_SECRET_KEY_TEST_PASS;
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const r = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body },
    );
    if (!r.ok) return { success: false, reason: `siteverify_http_${r.status}` };
    const json = (await r.json()) as {
      success: boolean;
      "error-codes"?: string[];
    };
    if (json.success) return { success: true, reason: null };
    return {
      success: false,
      reason: (json["error-codes"] && json["error-codes"][0]) || "verification_failed",
    };
  } catch (e) {
    return { success: false, reason: `siteverify_error_${(e as Error).message.slice(0, 40)}` };
  }
}

export type ReelMode = "comic" | "gif";
export type ReelPieceStatus =
  | "queued"
  | "master_in_flight"
  | "frames_in_flight"
  | "completed"
  | "failed";
export type ReelFrameStatus =
  | "queued"
  | "in_flight"
  | "inspecting"
  | "accepted"
  | "rejected_retrying"
  | "failed";

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

// Frame count constraints.
export const MIN_FRAMES = 8;
export const MAX_FRAMES = 20;
export const DEFAULT_FRAMES = 12;

// Per-visitor daily quota (pieces, not frames).
export const DAILY_QUOTA_PIECES = 2;

// Concurrent in-flight Luma calls per piece.
export const FRAME_PARALLELISM = 3;

// Frame retry budget before giving up.
export const MAX_FRAME_ATTEMPTS = 3;

// Soft cost estimates (USD) for accounting.
export const COST_PER_LUMA_UNI1 = 0.0404;
export const COST_PER_LUMA_UNI1_MAX = 0.10;
export const COST_PER_OPUS_INSPECTION = 0.005; // rough estimate, per call
export const COST_PER_OPUS_ENHANCE = 0.003;

export const VALID_MODES: ReelMode[] = ["comic", "gif"];

const LUMA_BASE = "https://agents.lumalabs.ai/v1";
const ID_ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newPieceId(): string {
  const t = Date.now().toString(36);
  let rand = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ID_ALPHA[b % ID_ALPHA.length];
  return `rl_${t}${rand}`.slice(0, 24);
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export async function visitorHash(req: Request, env: ReelEnv): Promise<string> {
  const ip =
    req.headers.get("CF-Connecting-IP") ??
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "0.0.0.0";
  return sha256Hex(`${ip}|${utcDay()}|${env.VISITOR_HASH_SALT}`);
}

export function jsonResponse(obj: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(obj), { ...init, headers });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ ok: false, error: { code, message } }, { status });
}

// Slug from a story title — kebab-case, ASCII, max 56 chars + short suffix.
export function slugify(input: string, suffix: string): string {
  const ascii = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56);
  return ascii ? `${ascii}-${suffix}` : suffix;
}

// ---------- Luma submit + poll + image fetch ----------

export async function lumaSubmitImage(
  prompt: string,
  env: ReelEnv,
  opts?: { model?: "uni-1" | "uni-1-max"; aspect_ratio?: string },
): Promise<LumaGeneration> {
  const r = await fetch(`${LUMA_BASE}/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LUMA_AGENTS_API_KEY}`,
    },
    body: JSON.stringify({
      type: "image",
      model: opts?.model ?? "uni-1",
      prompt,
      aspect_ratio: opts?.aspect_ratio ?? "1:1",
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`luma submit ${r.status}: ${detail.slice(0, 200)}`);
  }
  return (await r.json()) as LumaGeneration;
}

export async function lumaSubmitImageEdit(
  prompt: string,
  source_url: string,
  env: ReelEnv,
  opts?: { model?: "uni-1" | "uni-1-max" },
): Promise<LumaGeneration> {
  const r = await fetch(`${LUMA_BASE}/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LUMA_AGENTS_API_KEY}`,
    },
    body: JSON.stringify({
      type: "image_edit",
      model: opts?.model ?? "uni-1",
      prompt,
      source: { url: source_url },
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`luma image_edit ${r.status}: ${detail.slice(0, 200)}`);
  }
  return (await r.json()) as LumaGeneration;
}

export async function lumaGet(lumaId: string, env: ReelEnv): Promise<LumaGeneration> {
  const r = await fetch(`${LUMA_BASE}/generations/${lumaId}`, {
    headers: { Authorization: `Bearer ${env.LUMA_AGENTS_API_KEY}` },
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`luma get ${r.status}: ${detail.slice(0, 200)}`);
  }
  return (await r.json()) as LumaGeneration;
}

export async function fetchImageBytes(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const bytes = await r.arrayBuffer();
  const contentType = r.headers.get("content-type") ?? "image/png";
  return { bytes, contentType };
}

// ---------- Safety filtering ----------
// Operator durable rule (2026-06-08): no OpenAI anywhere in Reel.
// Safety filtering now happens inside the Claude enhancer prompts (they
// emit `BLOCKED: <reason>` on unsafe input) plus Luma's own non-disableable
// moderation backstop. The pre-Luma OpenAI moderation pass was removed.
// `moderationFlagged` is kept as a no-op stub so existing call sites
// compile without rewrites; it always returns { flagged: false, reason: null }.

export async function moderationFlagged(
  _text: string,
  _env: ReelEnv,
): Promise<{ flagged: boolean; reason: string | null }> {
  return { flagged: false, reason: null };
}

// ---------- Bridge: character + story enhancement ----------
// Reel's text-only Claude calls go through a long-lived Bun bridge that
// subprocess-spawns ~/.local/bin/claude on the operator's VM. Pages
// Functions never see ANTHROPIC_API_KEY. Bridge URL + bearer token are
// shipped via wrangler pages secret. The bridge owns the system prompts
// (same source-of-truth as the constants below); the request body shape
// is what Pages sends in.

export const ANTHROPIC_MODEL = "claude-opus-4-7";

type BridgeOk = { ok: true; text: string; cost_usd: number; duration_ms: number };
type BridgeErr = { ok: false; code: string; message: string };

async function callBridge(
  env: ReelEnv,
  path: "/enhance-character" | "/enhance-story" | "/inspect-frame",
  body: Record<string, unknown>,
): Promise<BridgeOk> {
  if (!env.REEL_BRIDGE_URL || !env.REEL_BRIDGE_TOKEN) {
    throw new Error("bridge_not_configured");
  }
  const url = env.REEL_BRIDGE_URL.replace(/\/$/, "") + path;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.REEL_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`bridge_network_error: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch (e) {
    throw new Error(`bridge_invalid_json status=${resp.status}: ${(e as Error).message}`);
  }
  const o = (json ?? {}) as Record<string, unknown>;
  if (o.ok === true) {
    return {
      ok: true,
      text: typeof o.text === "string" ? o.text : "",
      cost_usd: typeof o.cost_usd === "number" ? o.cost_usd : 0,
      duration_ms: typeof o.duration_ms === "number" ? o.duration_ms : 0,
    };
  }
  const code = typeof o.code === "string" ? o.code : `http_${resp.status}`;
  const message = typeof o.message === "string" ? o.message : "bridge call failed";
  throw new Error(`bridge_${code}: ${message.slice(0, 200)}`);
}

// Maximum length for the raw character / story user input.
export const MAX_RAW_CHARACTER_CHARS = 600;
export const MAX_RAW_STORY_CHARS = 900;

// Character-enhancer system prompt lives in the bridge. The bridge is the
// source of truth; this file forwards { raw } and parses the BLOCKED:
// prefix on return.

export async function enhanceCharacterAnthropic(
  raw: string,
  env: ReelEnv,
): Promise<{ enhanced: string | null; blocked: boolean; blockReason: string | null }> {
  const result = await callBridge(env, "/enhance-character", { raw });
  const cleaned = result.text.replace(/\s*\n+\s*/g, "\n").trim();
  if (cleaned.startsWith("BLOCKED:")) {
    return { enhanced: null, blocked: true, blockReason: cleaned.slice("BLOCKED:".length).trim() };
  }
  return { enhanced: cleaned, blocked: false, blockReason: null };
}

// Story-enhancer system prompt lives in the bridge. The bridge returns
// the strict JSON beat sheet as a string in `.text`; this side
// JSON.parses, validates shape, and surfaces blocked path.

export async function enhanceStoryAnthropic(args: {
  raw: string;
  characterEnhanced: string;
  frameCount: number;
  env: ReelEnv;
}): Promise<{
  beatSheet: {
    title: string;
    logline: string;
    panels: Array<{ index: number; beat: string; visual_prompt: string }>;
  } | null;
  blocked: boolean;
  blockReason: string | null;
}> {
  const result = await callBridge(args.env, "/enhance-story", {
    raw: args.raw,
    characterEnhanced: args.characterEnhanced,
    frameCount: args.frameCount,
  });
  const stripped = result.text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`story_json_parse_failed: ${stripped.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("story_json_not_object");
  }
  const o = parsed as Record<string, unknown>;
  if (o.blocked === true) {
    return { beatSheet: null, blocked: true, blockReason: String(o.reason ?? "policy") };
  }
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const logline = typeof o.logline === "string" ? o.logline.trim() : "";
  const panelsRaw = Array.isArray(o.panels) ? o.panels : [];
  if (!title || !logline || panelsRaw.length !== args.frameCount) {
    throw new Error(`story_shape_invalid: title=${!!title} logline=${!!logline} panels=${panelsRaw.length}/${args.frameCount}`);
  }
  const panels = panelsRaw.map((p, i) => {
    const pp = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
    return {
      index: typeof pp.index === "number" ? pp.index : i + 1,
      beat: String(pp.beat ?? "").trim(),
      visual_prompt: String(pp.visual_prompt ?? "").trim(),
    };
  });
  for (const p of panels) {
    if (!p.beat || !p.visual_prompt) {
      throw new Error(`panel_missing_field at index ${p.index}`);
    }
  }
  return { beatSheet: { title, logline, panels }, blocked: false, blockReason: null };
}

// ---------- Bridge: frame inspection (claude CLI multimodal via Read tool) ----------
// The bridge owns the multimodal call. It downloads master_url and frame_url
// to local /tmp paths, then spawns `claude --print --model opus --allowedTools Read`
// with a prompt that asks Claude to Read both files and output strict JSON.
// No OpenAI, no external vision API. Operator durable rule.

export async function inspectFrameAnthropic(args: {
  masterUrl: string;
  frameUrl: string;
  env: ReelEnv;
}): Promise<{ accept: boolean; reason: string; drift: number }> {
  const result = await callBridge(args.env, "/inspect-frame", {
    master_url: args.masterUrl,
    frame_url: args.frameUrl,
  });
  const text = result.text.trim();
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`inspect_json_parse_failed: ${stripped.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("inspect_json_not_object");
  }
  const o = parsed as Record<string, unknown>;
  // Bridge inspector prompt emits {drift, accept, reason}. Accept either
  // schema (drift or drift_severity) and either accept (bool) or derive
  // accept from drift <= 3.
  const driftRaw = typeof o.drift === "number"
    ? o.drift
    : typeof o.drift_severity === "number"
      ? o.drift_severity
      : 3;
  const drift = Math.max(1, Math.min(5, Math.floor(driftRaw)));
  const accept = typeof o.accept === "boolean" ? o.accept : drift <= 3;
  const reason = typeof o.reason === "string" ? o.reason : "no reason given";
  return { accept, reason, drift };
}

// ---------- D1 in-flight rate limit ----------

// Returns the in-flight piece for this visitor, if any. "In flight" means a
// piece this visitor created that is still being driven by /api/reel/status —
// status in (queued, master_in_flight, frames_in_flight). Used by
// generate.ts to refuse a second concurrent submission until the first
// terminalizes (completed / failed). The same primitive (visitor_hash)
// rate-limits at one-per-IP-per-day granularity via DAILY_QUOTA_PIECES,
// but the in-flight check fires immediately even when daily quota has
// headroom.
export async function checkInFlightForVisitor(
  env: ReelEnv,
  visitor: string,
): Promise<{ inFlight: boolean; pieceId: string | null; draftUrl: string | null }> {
  const row = await env.DB
    .prepare(
      `SELECT id FROM reel_pieces
       WHERE visitor_hash = ?
         AND status IN ('queued','master_in_flight','frames_in_flight')
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .bind(visitor)
    .first<{ id: string }>();
  if (!row) return { inFlight: false, pieceId: null, draftUrl: null };
  return { inFlight: true, pieceId: row.id, draftUrl: `/reel/draft/${row.id}/` };
}

// ---------- D1 quota ----------

export async function checkAndIncrementPieceQuota(
  env: ReelEnv,
  visitor: string,
): Promise<{ remaining: number; over: boolean }> {
  const day = utcDay();
  const row = await env.DB
    .prepare("SELECT count FROM reel_daily_quota WHERE visitor_hash=? AND day=?")
    .bind(visitor, day)
    .first<{ count: number }>();
  const current = row?.count ?? 0;
  if (current >= DAILY_QUOTA_PIECES) return { remaining: 0, over: true };
  await env.DB
    .prepare(
      `INSERT INTO reel_daily_quota (visitor_hash, day, count) VALUES (?, ?, 1)
       ON CONFLICT (visitor_hash, day) DO UPDATE SET count = count + 1`,
    )
    .bind(visitor, day)
    .run();
  return { remaining: DAILY_QUOTA_PIECES - current - 1, over: false };
}
