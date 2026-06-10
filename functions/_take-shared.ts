// Shared helpers + canonical constants for /take/ Pages Functions.
// Invariant-drift rule: every value used in more than one place lives HERE
// (ID regex, R2 key formats, status enums, axis names, costs). No inline copies.

export type TakeEnv = {
  DB: D1Database;
  TAKE_BUCKET: R2Bucket;
  LUMA_AGENTS_API_KEY: string;
  // Take calls claude through the long-lived Bun bridge (subprocess spawns
  // the local `claude` CLI). Operator durable rule: no ANTHROPIC_API_KEY
  // anywhere. Bridge URL + bearer shipped via wrangler pages secret.
  TAKE_BRIDGE_URL: string;
  TAKE_BRIDGE_TOKEN: string;
  VISITOR_HASH_SALT: string;
  TURNSTILE_SECRET_KEY?: string;
};

// ---------- enums ----------

export type TakePieceStatus =
  | "queued"
  | "composing"
  | "generating"
  | "ingesting"
  | "evaluating"
  | "judging"
  | "retaking"
  | "completed"
  | "failed";

export type TakeAttemptStatus =
  | "composing"
  | "submitted"
  | "generating"
  | "downloading"
  | "evaluating"
  | "judging"
  | "accepted"
  | "retake"
  | "failed";

export type TakeDecision = "accept" | "retake" | "abort";

// The six judged axes. Deterministic lanes own temporal axes; the judge
// owns semantics. Keep names in lockstep with the bridge judge prompt and
// the take-engine results schema.
export const TAKE_AXES = [
  "fidelity",        // per-frame visual quality (judge, from contact sheet)
  "aesthetics",      // composition, lighting, color (judge)
  "consistency",     // subject identity over time (dino_drift lane + judge confirm)
  "motion",          // quantity + plausibility (flow lane; judge NEVER asked about order)
  "semantics",       // prompt adherence (clipscore lane + judge)
  "physics",         // commonsense/physics violations (judge)
] as const;
export type TakeAxis = (typeof TAKE_AXES)[number];

// Discrete judgment levels (Q-Align: discrete levels beat raw scalar scores).
export const TAKE_LEVELS = ["excellent", "good", "fair", "poor", "bad"] as const;
export type TakeLevel = (typeof TAKE_LEVELS)[number];

// ---------- generation constraints ----------

export const VALID_RESOLUTIONS = ["540p", "720p", "1080p"] as const;
export const VALID_DURATIONS = ["5s", "10s"] as const;
export const VALID_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"] as const;
export const DEFAULT_RESOLUTION = "540p";
export const DEFAULT_DURATION = "5s";
export const DEFAULT_ASPECT = "16:9";

export const MAX_ATTEMPTS = 3;
export const DAILY_QUOTA_PIECES = 3;       // per visitor
export const GLOBAL_DAILY_CAP = 20;        // all visitors combined
export const MAX_PROMPT_CHARS = 800;

// Ray3.2 T2V pricing (USD) per docs.agents.lumalabs.ai (verified 2026-06-10).
export const COST_RAY32: Record<string, number> = {
  "540p/5s": 0.15,
  "540p/10s": 0.45,
  "720p/5s": 0.30,
  "720p/10s": 0.90,
  "1080p/5s": 1.20,
  "1080p/10s": 3.60,
};
export function costForClip(resolution: string, duration: string): number {
  return COST_RAY32[`${resolution}/${duration}`] ?? 0.15;
}

// ---------- ids, keys, slugs ----------

const ID_ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";

// Canonical piece-id shape: `tk_` prefix + up to 21 base36 chars (24 total).
export const PIECE_ID_RE = /^tk_[A-Za-z0-9]{1,22}$/;
export function isValidPieceId(s: unknown): s is string {
  return typeof s === "string" && PIECE_ID_RE.test(s);
}

export function newPieceId(): string {
  const t = Date.now().toString(36);
  let rand = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ID_ALPHA[b % ID_ALPHA.length];
  return `tk_${t}${rand}`.slice(0, 24);
}

// Canonical R2 key formats. Import these builders everywhere; never
// hand-assemble keys inline.
export function videoKey(pieceId: string, attempt: number): string {
  return `video/${pieceId}/${attempt}.mp4`;
}
export function sheetKey(pieceId: string, attempt: number): string {
  return `sheet/${pieceId}/${attempt}.jpg`;
}
export function frameKey(pieceId: string, attempt: number, n: number): string {
  return `frame/${pieceId}/${attempt}/${n}.jpg`;
}

export function slugify(input: string, suffix: string): string {
  const ascii = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56);
  return ascii ? `${ascii}-${suffix}` : suffix;
}

// ---------- visitor identity + quota ----------

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

export async function visitorHash(req: Request, env: TakeEnv): Promise<string> {
  const ip =
    req.headers.get("CF-Connecting-IP") ??
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "0.0.0.0";
  return sha256Hex(`${ip}|${utcDay()}|${env.VISITOR_HASH_SALT}`);
}

// ---------- responses ----------

export function jsonResponse(obj: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(obj), { ...init, headers });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ ok: false, error: { code, message } }, { status });
}

// ---------- Luma Ray3.2 ----------

const LUMA_BASE = "https://agents.lumalabs.ai/v1";

export type LumaState = "queued" | "processing" | "completed" | "failed";
export type LumaVideoGeneration = {
  id: string;
  state: LumaState;
  assets?: { video?: string } | null;
  output?: { type: string; url: string }[] | null;
  failure_reason?: string | null;
  failure_code?: string | null;
  model: string;
  created_at: string;
};

export type ComposedRequest = {
  prompt: string;
  resolution: (typeof VALID_RESOLUTIONS)[number];
  duration: (typeof VALID_DURATIONS)[number];
  aspect_ratio: (typeof VALID_ASPECTS)[number];
};

export async function lumaSubmitVideo(
  composed: ComposedRequest,
  env: TakeEnv,
): Promise<LumaVideoGeneration> {
  const r = await fetch(`${LUMA_BASE}/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LUMA_AGENTS_API_KEY}`,
    },
    // Schema per LUMA_RAY32.md (verified live): prompt + aspect_ratio at the
    // TOP level; only resolution/duration nest under video. Nesting prompt
    // inside video returns 422.
    body: JSON.stringify({
      model: "ray-3.2",
      type: "video",
      prompt: composed.prompt,
      aspect_ratio: composed.aspect_ratio,
      video: {
        resolution: composed.resolution,
        duration: composed.duration,
      },
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`luma submit ${r.status}: ${detail.slice(0, 200)}`);
  }
  return (await r.json()) as LumaVideoGeneration;
}

export async function lumaGetGeneration(
  id: string,
  env: TakeEnv,
): Promise<LumaVideoGeneration> {
  const r = await fetch(`${LUMA_BASE}/generations/${id}`, {
    headers: { Authorization: `Bearer ${env.LUMA_AGENTS_API_KEY}` },
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`luma get ${r.status}: ${detail.slice(0, 200)}`);
  }
  return (await r.json()) as LumaVideoGeneration;
}

// Extract the video URL from a completed generation (assets.video per the
// agents API; output[] kept as fallback).
export function lumaVideoUrl(gen: LumaVideoGeneration): string | null {
  if (gen.assets?.video) return gen.assets.video;
  const out = gen.output?.find((o) => o.type === "video");
  return out?.url ?? null;
}

// ---------- bridge (claude gateway) ----------

export async function bridgePost<T = Record<string, unknown>>(
  env: TakeEnv,
  path: string,
  body: unknown,
  timeoutMs = 320_000,
): Promise<T> {
  const base = env.TAKE_BRIDGE_URL.replace(/\/$/, "");
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.TAKE_BRIDGE_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`bridge ${path} ${r.status}: non-json ${text.slice(0, 120)}`);
  }
  if (!r.ok || parsed.ok !== true) {
    throw new Error(`bridge ${path} ${r.status}: ${String(parsed.message ?? text).slice(0, 200)}`);
  }
  return parsed as T;
}

export async function bridgeGet<T = Record<string, unknown>>(
  env: TakeEnv,
  path: string,
  timeoutMs = 30_000,
): Promise<T> {
  const base = env.TAKE_BRIDGE_URL.replace(/\/$/, "");
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${env.TAKE_BRIDGE_TOKEN}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`bridge ${path} ${r.status}: non-json ${text.slice(0, 120)}`);
  }
  if (!r.ok || parsed.ok !== true) {
    throw new Error(`bridge ${path} ${r.status}: ${String(parsed.message ?? text).slice(0, 200)}`);
  }
  return parsed as T;
}

export async function bridgeGetBytes(
  env: TakeEnv,
  path: string,
  timeoutMs = 60_000,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const base = env.TAKE_BRIDGE_URL.replace(/\/$/, "");
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${env.TAKE_BRIDGE_TOKEN}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`bridge ${path} ${r.status}`);
  return {
    bytes: await r.arrayBuffer(),
    contentType: r.headers.get("content-type") ?? "application/octet-stream",
  };
}

// ---------- L3 decision (deterministic, from the judge's discrete levels) ----------

// Numeric weight per level for scoring/comparison across attempts.
export const LEVEL_SCORE: Record<string, number> = {
  excellent: 4,
  good: 3,
  fair: 2,
  poor: 1,
  bad: 0,
};

export type JudgeVerdict = {
  axes: Record<string, { rationale: string; level: string }>;
  summary?: string;
  retake_advice?: string;
};

export function verdictScore(v: JudgeVerdict): number {
  let total = 0;
  for (const ax of TAKE_AXES) {
    total += LEVEL_SCORE[v.axes?.[ax]?.level ?? "bad"] ?? 0;
  }
  return total; // 0..24
}

// Accept when no axis lands at poor or bad. The judge advises; this rule
// decides. Bounded by MAX_ATTEMPTS at the call site.
export function verdictAccepts(v: JudgeVerdict): boolean {
  for (const ax of TAKE_AXES) {
    const level = v.axes?.[ax]?.level ?? "bad";
    if ((LEVEL_SCORE[level] ?? 0) <= 1) return false;
  }
  return true;
}

// ---------- event log ----------

export async function logEvent(
  env: TakeEnv,
  pieceId: string,
  attempt: number,
  event: string,
  stage: string,
  data: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO take_events (piece_id, attempt_index, event, stage, data_json)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(pieceId, attempt, event, stage, JSON.stringify(data ?? {}))
    .run();
}
