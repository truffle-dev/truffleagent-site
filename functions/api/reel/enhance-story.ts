// POST /api/reel/enhance-story
// Body: { story: string, character_enhanced: string, frame_count?: number }
// Returns: { ok: true, beat_sheet } | { ok: false, error }
//
// Steps:
//   1. Validate input shape and length.
//   2. Validate frame_count against MIN_FRAMES..MAX_FRAMES (default 12).
//   3. Safety filter (no-op stub; the bridge's story-enhancer prompt emits
//      `{ "blocked": true, "reason": ... }` on unsafe input, and Luma
//      backstops downstream).
//   4. Beat-sheet via Claude Opus 4.7 through the bridge subprocess.
//   5. Return structured panels. No D1 write — orchestrator on
//      /api/reel/generate persists.

import {
  type ReelEnv,
  DEFAULT_FRAMES,
  MAX_FRAMES,
  MAX_RAW_STORY_CHARS,
  MIN_FRAMES,
  enhanceStoryAnthropic,
  errorResponse,
  jsonResponse,
  moderationFlagged,
} from "../../_reel-shared.ts";

type Body = {
  story?: string;
  character_enhanced?: string;
  frame_count?: number;
};

export const onRequestPost: PagesFunction<ReelEnv> = async (ctx) => {
  let body: Body;
  try {
    body = (await ctx.request.json()) as Body;
  } catch {
    return errorResponse(400, "bad_json", "Body must be JSON");
  }

  const raw = (body.story ?? "").trim();
  if (!raw) return errorResponse(400, "missing_story", "Story idea is required");
  if (raw.length < 4) return errorResponse(400, "story_too_short", "Story idea is too short");
  if (raw.length > MAX_RAW_STORY_CHARS) {
    return errorResponse(
      400,
      "story_too_long",
      `Story idea must be <= ${MAX_RAW_STORY_CHARS} characters`,
    );
  }

  const characterEnhanced = (body.character_enhanced ?? "").trim();
  if (!characterEnhanced) {
    return errorResponse(400, "missing_character_enhanced", "character_enhanced is required");
  }
  if (characterEnhanced.length < 40 || characterEnhanced.length > 4000) {
    return errorResponse(400, "character_enhanced_invalid", "character_enhanced has an invalid length");
  }

  const requested = Number.isFinite(body.frame_count) ? Math.floor(body.frame_count as number) : DEFAULT_FRAMES;
  if (requested < MIN_FRAMES || requested > MAX_FRAMES) {
    return errorResponse(
      400,
      "frame_count_out_of_range",
      `frame_count must be between ${MIN_FRAMES} and ${MAX_FRAMES}`,
    );
  }
  const frameCount = requested;

  if (!ctx.env.REEL_BRIDGE_URL || !ctx.env.REEL_BRIDGE_TOKEN) {
    return errorResponse(503, "service_unavailable", "Story beat-sheet generation is not yet configured");
  }

  const mod = await moderationFlagged(raw, ctx.env);
  if (mod.flagged) {
    return errorResponse(
      422,
      "moderation_blocked",
      `That story was blocked by safety filters (${mod.reason}).`,
    );
  }

  try {
    const result = await enhanceStoryAnthropic({
      raw,
      characterEnhanced,
      frameCount,
      env: ctx.env,
    });
    if (result.blocked || !result.beatSheet) {
      return errorResponse(422, "policy_blocked", result.blockReason ?? "Story blocked by policy");
    }
    return jsonResponse({
      ok: true,
      raw,
      beat_sheet: result.beatSheet,
      frame_count: frameCount,
    });
  } catch (e) {
    console.error("enhance-story failed:", (e as Error).message);
    return errorResponse(502, "enhance_failed", "Story enhancement service failed; try again.");
  }
};
