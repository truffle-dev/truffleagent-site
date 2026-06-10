// Shared helpers + canonical constants for /cut/ Pages Functions.
// Cut = multi-shot pieces stitched into one video. Evolved from Take;
// Take's files are untouched — this module is the Cut namespace's single
// source of truth. Invariant-drift rule: every value used in more than one
// place lives HERE (ID regex, R2 key formats, status enums, axis names,
// costs, bounds). No inline copies.

export type CutEnv = {
  DB: D1Database;
  CUT_BUCKET: R2Bucket;
  LUMA_AGENTS_API_KEY: string;
  // Cut calls claude through the long-lived Bun bridge (subprocess spawns
  // the local `claude` CLI). Operator durable rule: no ANTHROPIC_API_KEY
  // anywhere. Own secret names so Cut and Take rotate independently, even
  // when both point at the same bridge instance.
  CUT_BRIDGE_URL: string;
  CUT_BRIDGE_TOKEN: string;
  VISITOR_HASH_SALT: string;
  TURNSTILE_SECRET_KEY?: string;
};

// ---------- enums ----------

export type CutPieceStatus =
  | "queued"
  | "planning"
  | "shooting"
  | "stitching"
  | "judging"
  | "revising"
  | "completed"
  | "failed";

export type CutShotStatus =
  | "composing"
  | "generating"
  | "ingesting"
  | "evaluating"
  | "judging"
  | "accepted"
  | "retake"
  | "failed";

export type CutDecision = "accept" | "retake" | "abort";

// Per-shot axes are Take's six, judged on the shot's contact sheet.
// Keep names in lockstep with the bridge judge prompt and take-engine.
export const SHOT_AXES = [
  "fidelity",
  "aesthetics",
  "consistency",
  "motion",
  "semantics",
  "physics",
] as const;
export type ShotAxis = (typeof SHOT_AXES)[number];

// Final-cut axes add continuity (seam coherence: identity, style, light,
// spatial logic across cuts). Judged on the final contact sheet + seam sheet.
export const CUT_AXES = [...SHOT_AXES, "continuity"] as const;
export type CutAxis = (typeof CUT_AXES)[number];

export const CUT_LEVELS = ["excellent", "good", "fair", "poor", "bad"] as const;
export type CutLevel = (typeof CUT_LEVELS)[number];

// ---------- generation constraints + bounds ----------

export const VALID_RESOLUTIONS = ["540p", "720p", "1080p"] as const;
export const VALID_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"] as const;
export const DEFAULT_RESOLUTION = "720p";
export const DEFAULT_ASPECT = "16:9";

// Every shot is a 5s Ray3.2 clip. target_seconds picks the shot count.
export const SHOT_DURATION = "5s";
export const SHOT_SECONDS = 5;
export const MIN_SHOTS = 2;
export const MAX_SHOTS = 6;
export const VALID_TARGET_SECONDS = [10, 15, 20, 25, 30] as const;
export const DEFAULT_TARGET_SECONDS = 15;

export const MAX_SHOT_ATTEMPTS = 3;     // per (version, shot)
export const REVISION_CAP = 5;          // chat revision rounds per piece
export const MAX_REVISION_CHARS = 500;
export const COST_CEILING_USD = 4.5;    // hard per-piece ceiling, all versions
export const DAILY_QUOTA_PIECES = 2;    // per visitor
export const GLOBAL_DAILY_CAP = 10;     // all visitors combined
export const MAX_PROMPT_CHARS = 800;

export function shotCountForSeconds(target: number): number {
  const n = Math.round(target / SHOT_SECONDS);
  return Math.min(MAX_SHOTS, Math.max(MIN_SHOTS, n));
}

// Ray3.2 pricing (USD) per docs.agents.lumalabs.ai (verified 2026-06-10).
export const COST_RAY32: Record<string, number> = {
  "540p/5s": 0.15,
  "720p/5s": 0.3,
  "1080p/5s": 1.2,
};
export function costForShot(resolution: string): number {
  return COST_RAY32[`${resolution}/${SHOT_DURATION}`] ?? 0.3;
}

// ---------- composition document ----------
// The composition JSON (cut_compositions.doc) is the source of truth.
// Renders are pure functions of it. Append-only versions; rollback free.

export type ShotConditioning =
  | { mode: "none" }
  // chain: condition on the LAST sampled frame of source_shot's accepted
  // render (take-eval always samples the final frame; it is already in R2).
  | { mode: "chain"; source_shot: string; image_url?: string };

export type CompositionShot = {
  id: string;                 // s1..s6, stable across versions
  order: number;              // 0-based timeline order
  prompt: string;             // shot-specific prompt (style_block appended at compose)
  duration_s: number;         // always SHOT_SECONDS for v1
  conditioning: ShotConditioning;
  content_hash?: string;      // sha256(model|prompt|style|spec|conditioning-fingerprint)
  artifact?: {
    video_key: string;
    sheet_key: string;
    last_frame_url: string;   // public /i-cut/ URL of final sampled frame
    attempt: number;
    from_version?: number;    // set on cache reuse
  };
};

export type CompositionTransition = {
  after: string;              // shot id this transition follows
  type: "cut" | "xfade";
  duration: number;           // seconds; 0 for cut
};

export type CompositionDoc = {
  version: number;
  parent_version?: number;
  revision_note?: string;     // user note that produced this version
  title?: string;
  aspect_ratio: (typeof VALID_ASPECTS)[number];
  resolution: (typeof VALID_RESOLUTIONS)[number];
  style_block: string;        // shared suffix appended to every shot prompt
  shots: CompositionShot[];
  transitions: CompositionTransition[];
  assembly?: {
    final_key: string;
    duration_s: number;
    seams: { after: string; dino_cosine: number }[];
  };
};

// Content-address a shot render. Conditioning fingerprint uses the SOURCE
// artifact's video_key so regenerating shot N invalidates chained shot N+1.
export async function shotContentHash(
  doc: CompositionDoc,
  shot: CompositionShot,
  conditioningFingerprint: string,
): Promise<string> {
  return sha256Hex(
    [
      "ray-3.2",
      shot.prompt,
      doc.style_block,
      `${shot.duration_s}s`,
      doc.aspect_ratio,
      doc.resolution,
      conditioningFingerprint,
    ].join("|"),
  );
}

// ---------- ids, keys, slugs ----------

const ID_ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";

// Canonical piece-id shape: `cu_` prefix + up to 22 base36 chars (24 total).
export const PIECE_ID_RE = /^cu_[A-Za-z0-9]{1,22}$/;
export function isValidPieceId(s: unknown): s is string {
  return typeof s === "string" && PIECE_ID_RE.test(s);
}

export const SHOT_ID_RE = /^s[1-9]$/;
export function isValidShotId(s: unknown): s is string {
  return typeof s === "string" && SHOT_ID_RE.test(s);
}

export function newPieceId(): string {
  const t = Date.now().toString(36);
  let rand = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ID_ALPHA[b % ID_ALPHA.length];
  return `cu_${t}${rand}`.slice(0, 24);
}

// Canonical R2 key formats, all version-scoped. Import these builders
// everywhere; never hand-assemble keys inline.
export function shotVideoKey(pieceId: string, version: number, shotId: string, attempt: number): string {
  return `video/${pieceId}/v${version}/${shotId}/${attempt}.mp4`;
}
export function shotSheetKey(pieceId: string, version: number, shotId: string, attempt: number): string {
  return `sheet/${pieceId}/v${version}/${shotId}/${attempt}.jpg`;
}
export function shotFrameKey(pieceId: string, version: number, shotId: string, attempt: number, n: number): string {
  return `frame/${pieceId}/v${version}/${shotId}/${attempt}/${n}.jpg`;
}
export function finalVideoKey(pieceId: string, version: number): string {
  return `final/${pieceId}/v${version}.mp4`;
}
export function finalSheetKey(pieceId: string, version: number): string {
  return `fsheet/${pieceId}/v${version}.jpg`;
}
export function seamSheetKey(pieceId: string, version: number): string {
  return `seams/${pieceId}/v${version}.jpg`;
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

export async function visitorHash(req: Request, env: CutEnv): Promise<string> {
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

export type ComposedShotRequest = {
  prompt: string;
  resolution: (typeof VALID_RESOLUTIONS)[number];
  aspect_ratio: (typeof VALID_ASPECTS)[number];
  // Public URL of the conditioning image (chain mode). Must be reachable by
  // Luma — we pass our own /i-cut/ frame URL, never a presigned Luma URL.
  start_frame_url?: string;
};

export async function lumaSubmitVideo(
  composed: ComposedShotRequest,
  env: CutEnv,
): Promise<LumaVideoGeneration> {
  const video: Record<string, unknown> = {
    resolution: composed.resolution,
    duration: SHOT_DURATION,
  };
  if (composed.start_frame_url) {
    video.start_frame = { url: composed.start_frame_url };
  }
  const r = await fetch(`${LUMA_BASE}/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LUMA_AGENTS_API_KEY}`,
    },
    // Schema per LUMA_RAY32.md (verified live): prompt + aspect_ratio at the
    // TOP level; only resolution/duration/start_frame nest under video.
    body: JSON.stringify({
      model: "ray-3.2",
      type: "video",
      prompt: composed.prompt,
      aspect_ratio: composed.aspect_ratio,
      video,
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
  env: CutEnv,
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

export function lumaVideoUrl(gen: LumaVideoGeneration): string | null {
  if (gen.assets?.video) return gen.assets.video;
  const out = gen.output?.find((o) => o.type === "video");
  return out?.url ?? null;
}

// ---------- bridge (claude gateway) ----------

export async function bridgePost<T = Record<string, unknown>>(
  env: CutEnv,
  path: string,
  body: unknown,
  timeoutMs = 320_000,
): Promise<T> {
  const base = env.CUT_BRIDGE_URL.replace(/\/$/, "");
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.CUT_BRIDGE_TOKEN}`,
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
  env: CutEnv,
  path: string,
  timeoutMs = 30_000,
): Promise<T> {
  const base = env.CUT_BRIDGE_URL.replace(/\/$/, "");
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${env.CUT_BRIDGE_TOKEN}` },
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
  env: CutEnv,
  path: string,
  timeoutMs = 60_000,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const base = env.CUT_BRIDGE_URL.replace(/\/$/, "");
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${env.CUT_BRIDGE_TOKEN}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`bridge ${path} ${r.status}`);
  return {
    bytes: await r.arrayBuffer(),
    contentType: r.headers.get("content-type") ?? "application/octet-stream",
  };
}

// ---------- decisions from discrete levels ----------

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

// Per-shot score, 0..24 over SHOT_AXES.
export function shotVerdictScore(v: JudgeVerdict): number {
  let total = 0;
  for (const ax of SHOT_AXES) {
    total += LEVEL_SCORE[v.axes?.[ax]?.level ?? "bad"] ?? 0;
  }
  return total;
}

export function shotVerdictAccepts(v: JudgeVerdict): boolean {
  for (const ax of SHOT_AXES) {
    const level = v.axes?.[ax]?.level ?? "bad";
    if ((LEVEL_SCORE[level] ?? 0) <= 1) return false;
  }
  return true;
}

// Final-cut score, 0..28 over CUT_AXES (adds continuity).
export function cutVerdictScore(v: JudgeVerdict): number {
  let total = 0;
  for (const ax of CUT_AXES) {
    total += LEVEL_SCORE[v.axes?.[ax]?.level ?? "bad"] ?? 0;
  }
  return total;
}

export function cutVerdictAccepts(v: JudgeVerdict): boolean {
  for (const ax of CUT_AXES) {
    const level = v.axes?.[ax]?.level ?? "bad";
    if ((LEVEL_SCORE[level] ?? 0) <= 1) return false;
  }
  return true;
}

// ---------- edit routing (chat revisions) ----------

// Deterministic ops are free ffmpeg re-assembly; generative ops regenerate
// touched shots at Luma cost. The bridge's route-edit call classifies; this
// type is the contract.
export type EditPlan = {
  kind: "deterministic" | "generative" | "mixed" | "reject";
  note: string;                       // plain-English summary shown in chat
  ops: EditOp[];
};

export type EditOp =
  | { op: "reorder"; order: string[] }                       // shot ids in new order
  | { op: "trim"; shot: string; duration_s: number }
  | { op: "transition"; after: string; type: "cut" | "xfade"; duration: number }
  | { op: "retitle"; title: string }
  | { op: "regen"; shot: string; prompt: string }            // revised shot prompt
  | { op: "style"; style_block: string };                    // global style change → regen all

// ---------- event log ----------

export async function logEvent(
  env: CutEnv,
  pieceId: string,
  version: number,
  shotId: string | null,
  event: string,
  stage: string,
  data: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cut_events (piece_id, version, shot_id, event, stage, data_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(pieceId, version, shotId, event, stage, JSON.stringify(data ?? {}))
    .run();
}
