// POST /api/cut/create
// Body: { prompt: string, target_seconds?: 10|15|20|25|30, aspect_ratio?: string }
// Creates a cut_pieces row (status=queued), charges the per-visitor daily
// quota, and returns { id, slug }. The status driver (GET /api/cut/status/<id>)
// advances the piece from there: planning → shooting → stitching → judging.
// No cut_compositions row yet — version 1's doc is written by the planning step.

import {
  type CutEnv,
  DAILY_QUOTA_PIECES,
  GLOBAL_DAILY_CAP,
  MAX_PROMPT_CHARS,
  DEFAULT_RESOLUTION,
  DEFAULT_ASPECT,
  DEFAULT_TARGET_SECONDS,
  VALID_ASPECTS,
  VALID_TARGET_SECONDS,
  newPieceId,
  slugify,
  utcDay,
  visitorHash,
  jsonResponse,
  errorResponse,
  logEvent,
} from "../../_cut-shared.ts";

export const onRequestPost: PagesFunction<CutEnv> = async (ctx) => {
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

  // Explicitly-provided invalid values are rejected; only absence defaults.
  let targetSeconds: number = DEFAULT_TARGET_SECONDS;
  if (body.target_seconds !== undefined) {
    if (
      typeof body.target_seconds !== "number" ||
      !(VALID_TARGET_SECONDS as readonly number[]).includes(body.target_seconds)
    ) {
      return errorResponse(
        400,
        "bad_target_seconds",
        `target_seconds must be one of ${VALID_TARGET_SECONDS.join(", ")}.`,
      );
    }
    targetSeconds = body.target_seconds;
  }
  let aspect: string = DEFAULT_ASPECT;
  if (body.aspect_ratio !== undefined) {
    if (
      typeof body.aspect_ratio !== "string" ||
      !(VALID_ASPECTS as readonly string[]).includes(body.aspect_ratio)
    ) {
      return errorResponse(400, "bad_aspect_ratio", `aspect_ratio must be one of ${VALID_ASPECTS.join(", ")}.`);
    }
    aspect = body.aspect_ratio;
  }

  const vhash = await visitorHash(ctx.request, ctx.env);
  const day = utcDay();

  // Per-visitor quota.
  const mine = await ctx.env.DB.prepare(
    `SELECT count FROM cut_daily_quota WHERE visitor_hash = ?1 AND day = ?2`,
  )
    .bind(vhash, day)
    .first<{ count: number }>();
  if ((mine?.count ?? 0) >= DAILY_QUOTA_PIECES) {
    return errorResponse(429, "quota_exceeded", `Daily limit of ${DAILY_QUOTA_PIECES} cuts reached. Come back tomorrow.`);
  }

  // Global daily cap (all visitors).
  const global = await ctx.env.DB.prepare(
    `SELECT COALESCE(SUM(count), 0) AS total FROM cut_daily_quota WHERE day = ?1`,
  )
    .bind(day)
    .first<{ total: number }>();
  if ((global?.total ?? 0) >= GLOBAL_DAILY_CAP) {
    return errorResponse(429, "global_cap", "Cut is at today's global capacity. Come back tomorrow.");
  }

  const id = newPieceId();
  const slug = slugify(prompt, id.slice(3, 9));

  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO cut_pieces
         (id, slug, prompt_raw, aspect_ratio, resolution, target_seconds, status, visitor_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7)`,
    ).bind(id, slug, prompt, aspect, DEFAULT_RESOLUTION, targetSeconds, vhash),
    ctx.env.DB.prepare(
      `INSERT INTO cut_daily_quota (visitor_hash, day, count) VALUES (?1, ?2, 1)
       ON CONFLICT (visitor_hash, day) DO UPDATE SET count = count + 1`,
    ).bind(vhash, day),
  ]);

  await logEvent(ctx.env, id, 1, null, "stage_start", "created", {
    target_seconds: targetSeconds,
    aspect_ratio: aspect,
    resolution: DEFAULT_RESOLUTION,
  });

  return jsonResponse({ ok: true, id, slug }, { status: 201 });
};
