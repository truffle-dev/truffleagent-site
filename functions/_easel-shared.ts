// Shared helpers + canonical constants for /easel/ Pages Functions.
// Easel = agent-operated creative canvas. Boards are single-doc JSON;
// the agent (claude CLI via the Bun bridge) reads and mutates the doc
// through board-scoped tools while the browser watches live.
// Invariant-drift rule: every value used in more than one place lives
// HERE (ID regexes, R2 key formats, limits, costs). No inline copies.

export type EaselEnv = {
  DB: D1Database;
  EASEL_BUCKET: R2Bucket;
  LUMA_AGENTS_API_KEY: string;
  // Easel calls claude through the long-lived Bun bridge (subprocess spawns
  // the local `claude` CLI). Operator durable rule: no ANTHROPIC_API_KEY
  // anywhere. Own secret names so Easel rotates independently of Reel/Cut,
  // even when all point at the same bridge instance.
  EASEL_BRIDGE_URL: string;
  EASEL_BRIDGE_TOKEN: string;
  VISITOR_HASH_SALT: string;
};

// ---------- ids ----------

const ID_ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";

export const BOARD_ID_RE = /^el_[a-z0-9]{8,22}$/;
export const SESSION_ID_RE = /^es_[a-z0-9]{8,22}$/;
export const IMAGE_ID_RE = /^ei_[a-z0-9]{8,22}$/;

function newId(prefix: string): string {
  const t = Date.now().toString(36);
  let rand = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ID_ALPHA[b % ID_ALPHA.length];
  return `${prefix}_${t}${rand}`.slice(0, 24);
}

export const newBoardId = () => newId("el");
export const newSessionId = () => newId("es");
export const newImageId = () => newId("ei");

// ---------- board document ----------

export type EaselElementType = "image" | "text" | "sticky" | "frame";

export type EaselElement = {
  id: string;                 // e<n> stable within a board
  type: EaselElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  rotation?: number;          // degrees
  props: Record<string, unknown>;
  // image: { src: "/i-easel/img/<board>/<ei_id>.png", natural_w, natural_h, alt? }
  // text:  { text, size, weight?, color?, align? }
  // sticky:{ text, color }
  // frame: { label, color? }
};

export type EaselDoc = {
  elements: EaselElement[];
  background: string;         // token name, e.g. "paper" | "dark" | "white"
};

export const VALID_BACKGROUNDS = ["white", "paper", "dark"] as const;

export const MAX_ELEMENTS = 200;
export const MAX_DOC_BYTES = 512 * 1024;   // 512 KB doc JSON ceiling
export const MAX_TEXT_CHARS = 2000;
export const MAX_TITLE_CHARS = 120;
export const MAX_PROMPT_CHARS = 1000;      // agent instruction length

export function emptyDoc(): EaselDoc {
  return { elements: [], background: "white" };
}

// Validate a board doc shape (boundary check, not exhaustive).
export function validateDoc(doc: unknown): { ok: true; doc: EaselDoc } | { ok: false; reason: string } {
  if (typeof doc !== "object" || doc === null) return { ok: false, reason: "doc must be an object" };
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.elements)) return { ok: false, reason: "doc.elements must be an array" };
  if (d.elements.length > MAX_ELEMENTS) return { ok: false, reason: `more than ${MAX_ELEMENTS} elements` };
  const bg = typeof d.background === "string" && (VALID_BACKGROUNDS as readonly string[]).includes(d.background)
    ? d.background : "white";
  const out: EaselElement[] = [];
  for (const el of d.elements as unknown[]) {
    if (typeof el !== "object" || el === null) return { ok: false, reason: "element must be an object" };
    const e = el as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length > 16) return { ok: false, reason: "bad element id" };
    if (!["image", "text", "sticky", "frame"].includes(e.type as string))
      return { ok: false, reason: `bad element type ${String(e.type)}` };
    for (const k of ["x", "y", "w", "h", "z"]) {
      if (typeof e[k] !== "number" || !Number.isFinite(e[k] as number))
        return { ok: false, reason: `element ${e.id}: ${k} must be a finite number` };
    }
    const props = typeof e.props === "object" && e.props !== null ? (e.props as Record<string, unknown>) : {};
    if (typeof props.text === "string" && props.text.length > MAX_TEXT_CHARS)
      return { ok: false, reason: `element ${e.id}: text too long` };
    // image src must be our own proxy path, never an arbitrary URL
    if (e.type === "image" && typeof props.src === "string" && !/^\/i-easel\/img\//.test(props.src))
      return { ok: false, reason: `element ${e.id}: image src must be /i-easel/img/...` };
    out.push({
      id: e.id as string,
      type: e.type as EaselElementType,
      x: e.x as number, y: e.y as number, w: e.w as number, h: e.h as number, z: e.z as number,
      rotation: typeof e.rotation === "number" ? (e.rotation as number) : undefined,
      props,
    });
  }
  return { ok: true, doc: { elements: out, background: bg } };
}

// ---------- R2 keys ----------
// Canonical builders; never hand-assemble keys inline.

export function imageKey(boardId: string, imageId: string, ext: string): string {
  return `img/${boardId}/${imageId}.${ext}`;
}
export function imagePath(boardId: string, imageId: string, ext: string): string {
  return `/i-easel/${imageKey(boardId, imageId, ext)}`;
}

export const VALID_UPLOAD_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB per image

// ---------- quotas + costs ----------

export const DAILY_QUOTA_SESSIONS = 6;       // agent runs per visitor per day
export const DAILY_QUOTA_GENERATIONS = 12;   // Luma images per visitor per day
export const DAILY_QUOTA_UPLOADS = 60;       // uploads per visitor per day
export const SESSION_GENERATION_CAP = 6;     // Luma images per agent session
export const COST_LUMA_IMAGE_USD = 0.0404;   // uni-1

// ---------- crypto / visitor ----------

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

export async function visitorHash(req: Request, env: EaselEnv): Promise<string> {
  const ip =
    req.headers.get("CF-Connecting-IP") ??
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "0.0.0.0";
  return sha256Hex(`${ip}|${utcDay()}|${env.VISITOR_HASH_SALT}`);
}

// Increment one quota column; returns whether the caller is over the cap.
export async function bumpQuota(
  env: EaselEnv,
  visitor: string,
  column: "sessions" | "generations" | "uploads",
  cap: number,
): Promise<{ over: boolean; count: number }> {
  const day = utcDay();
  await env.DB.prepare(
    `INSERT INTO easel_daily_quota (visitor_hash, day, ${column})
     VALUES (?1, ?2, 1)
     ON CONFLICT (visitor_hash, day) DO UPDATE SET ${column} = ${column} + 1`,
  ).bind(visitor, day).run();
  const row = await env.DB.prepare(
    `SELECT ${column} AS n FROM easel_daily_quota WHERE visitor_hash = ?1 AND day = ?2`,
  ).bind(visitor, day).first<{ n: number }>();
  const count = row?.n ?? 1;
  return { over: count > cap, count };
}

// ---------- render token ----------

// The read-only render route (/easel/render/<id>) is gated by an HMAC of the
// board id keyed with EASEL_BRIDGE_TOKEN. The bridge mints the same value
// (easel-routes.ts in reel-claude-bridge) and hands it to the per-session MCP
// subprocess, so only agent sessions can load the render surface. Message
// prefix is part of the contract — change it in BOTH places or nowhere.
export async function renderToken(boardId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`easel-render:${boardId}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ---------- events ----------

export async function logEvent(
  env: EaselEnv,
  sessionId: string,
  event: string,
  data: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO easel_events (session_id, event, data_json) VALUES (?1, ?2, ?3)`,
  ).bind(sessionId, event, JSON.stringify(data ?? {})).run();
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
