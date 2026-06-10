// POST /api/take/create
// Body: { prompt: string, resolution?: "540p"|"720p"|"1080p", duration?: "5s"|"10s" }
// Creates a take_pieces row (status=queued) + take_attempts row 1, charges the
// per-visitor daily quota, and returns { id, slug }. The status driver
// (GET /api/take/status/<id>) advances the piece from there.

import {
  type TakeEnv,
  DAILY_QUOTA_PIECES,
  GLOBAL_DAILY_CAP,
  MAX_ATTEMPTS,
  MAX_PROMPT_CHARS,
  DEFAULT_RESOLUTION,
  DEFAULT_DURATION,
  DEFAULT_ASPECT,
  VALID_RESOLUTIONS,
  VALID_DURATIONS,
  newPieceId,
  slugify,
  utcDay,
  visitorHash,
  jsonResponse,
  errorResponse,
  logEvent,
} from "../../_take-shared.ts";

export const onRequestPost: PagesFunction<TakeEnv> = async (ctx) => {
  let body: Record<string, unknown>;
  try {
    body = (await ctx.request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_json", "Body must be JSON.");
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return errorResponse(400, "missing_prompt", "Describe the video you want.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    return errorResponse(400, "prompt_too_long", `Prompt must be at most ${MAX_PROMPT_CHARS} characters.`);
  }

  const resolution =
    typeof body.resolution === "string" && (VALID_RESOLUTIONS as readonly string[]).includes(body.resolution)
      ? body.resolution
      : DEFAULT_RESOLUTION;
  const duration =
    typeof body.duration === "string" && (VALID_DURATIONS as readonly string[]).includes(body.duration)
      ? body.duration
      : DEFAULT_DURATION;

  const vhash = await visitorHash(ctx.request, ctx.env);
  const day = utcDay();

  // Per-visitor quota.
  const mine = await ctx.env.DB.prepare(
    `SELECT count FROM take_daily_quota WHERE visitor_hash = ?1 AND day = ?2`,
  )
    .bind(vhash, day)
    .first<{ count: number }>();
  if ((mine?.count ?? 0) >= DAILY_QUOTA_PIECES) {
    return errorResponse(429, "quota_exceeded", `Daily limit of ${DAILY_QUOTA_PIECES} takes reached. Come back tomorrow.`);
  }

  // Global daily cap (all visitors).
  const global = await ctx.env.DB.prepare(
    `SELECT COALESCE(SUM(count), 0) AS total FROM take_daily_quota WHERE day = ?1`,
  )
    .bind(day)
    .first<{ total: number }>();
  if ((global?.total ?? 0) >= GLOBAL_DAILY_CAP) {
    return errorResponse(429, "global_cap", "Take is at today's global capacity. Come back tomorrow.");
  }

  const id = newPieceId();
  const slug = slugify(prompt, id.slice(3, 9));

  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO take_pieces
         (id, slug, prompt_raw, resolution, duration, aspect_ratio, status,
          current_attempt, max_attempts, visitor_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', 1, ?7, ?8)`,
    ).bind(id, slug, prompt, resolution, duration, DEFAULT_ASPECT, MAX_ATTEMPTS, vhash),
    ctx.env.DB.prepare(
      `INSERT INTO take_attempts (piece_id, attempt_index, status)
       VALUES (?1, 1, 'composing')`,
    ).bind(id),
    ctx.env.DB.prepare(
      `INSERT INTO take_daily_quota (visitor_hash, day, count) VALUES (?1, ?2, 1)
       ON CONFLICT (visitor_hash, day) DO UPDATE SET count = count + 1`,
    ).bind(vhash, day),
  ]);

  await logEvent(ctx.env, id, 1, "stage_start", "created", { resolution, duration });

  return jsonResponse({ ok: true, id, slug }, { status: 201 });
};
