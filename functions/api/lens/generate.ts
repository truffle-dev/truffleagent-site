// POST /api/lens/generate
// Body: { prompt: string, style?, aspect?, model? }
// Returns: { ok: true, id, status: "queued", enhanced } or { ok: false, error }
//
// Steps:
//   1. Validate input.
//   2. Hash visitor by IP + day. Check daily quota.
//   3. Moderate raw text via OpenAI.
//   4. Enhance via OpenAI gpt-4o-mini.
//   5. Submit to Luma.
//   6. Insert pending row into D1.
//   7. Return id; client polls /api/lens/status/<id>.

import {
  type LensEnv,
  type StyleHint,
  type AspectRatio,
  type LumaModel,
  COST_MICROS,
  MAX_RAW_PROMPT_CHARS,
  VALID_ASPECTS,
  VALID_STYLES,
  VALID_MODELS,
  checkAndIncrementQuota,
  enhancePromptOpenAI,
  errorResponse,
  jsonResponse,
  lumaSubmit,
  moderationFlagged,
  newLensId,
  visitorHash,
} from "../../_lens-shared.ts";

type Body = {
  prompt?: string;
  style?: string;
  aspect?: string;
  model?: string;
};

export const onRequestPost: PagesFunction<LensEnv> = async (ctx) => {
  let body: Body;
  try {
    body = (await ctx.request.json()) as Body;
  } catch {
    return errorResponse(400, "bad_json", "Body must be JSON");
  }

  const raw = (body.prompt ?? "").trim();
  if (!raw) return errorResponse(400, "missing_prompt", "Prompt is required");
  if (raw.length > MAX_RAW_PROMPT_CHARS) {
    return errorResponse(400, "prompt_too_long", `Prompt must be <= ${MAX_RAW_PROMPT_CHARS} characters`);
  }

  const style: StyleHint = VALID_STYLES.includes((body.style ?? "auto") as StyleHint)
    ? ((body.style ?? "auto") as StyleHint)
    : "auto";
  const aspect: AspectRatio = VALID_ASPECTS.includes((body.aspect ?? "16:9") as AspectRatio)
    ? ((body.aspect ?? "16:9") as AspectRatio)
    : "16:9";
  const model: LumaModel = VALID_MODELS.includes((body.model ?? "uni-1") as LumaModel)
    ? ((body.model ?? "uni-1") as LumaModel)
    : "uni-1";

  const visitor = await visitorHash(ctx.request, ctx.env);

  const quota = await checkAndIncrementQuota(ctx.env, visitor);
  if (quota.over) {
    return errorResponse(429, "daily_quota_exceeded", "Daily quota reached. Come back tomorrow.");
  }

  const mod = await moderationFlagged(raw, ctx.env);
  if (mod.flagged) {
    return errorResponse(422, "moderation_blocked", `That prompt was blocked by safety filters (${mod.reason}).`);
  }

  let enhanced: string;
  try {
    const result = await enhancePromptOpenAI(raw, style, aspect, model, ctx.env);
    if (result.blocked || !result.enhanced) {
      return errorResponse(422, "policy_blocked", result.blockReason ?? "Prompt blocked by policy");
    }
    enhanced = result.enhanced;
  } catch (e) {
    console.error("enhance failed:", (e as Error).message);
    return errorResponse(502, "enhance_failed", "Prompt enhancement service failed; try again.");
  }

  let luma;
  try {
    luma = await lumaSubmit(enhanced, aspect, model, ctx.env);
  } catch (e) {
    console.error("luma submit failed:", (e as Error).message);
    return errorResponse(502, "luma_submit_failed", "Image service rejected the request; try a simpler prompt.");
  }

  const id = newLensId();
  await ctx.env.DB
    .prepare(
      `INSERT INTO lens_generations
         (id, luma_id, prompt_raw, prompt_enhanced, model, aspect_ratio, status, visitor_hash, cost_usd_micros)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, luma.id, raw, enhanced, model, aspect, luma.state, visitor, COST_MICROS[model])
    .run();

  return jsonResponse({
    ok: true,
    id,
    status: luma.state,
    enhanced,
    model,
    aspect,
    style,
    quota_remaining: quota.remaining,
  });
};
