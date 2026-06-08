// POST /api/reel/enhance-character
// Body: { character: string }
// Returns: { ok: true, raw, enhanced } | { ok: false, error }
//
// Steps:
//   1. Validate input shape and length.
//   2. Safety filter (no-op stub; the bridge's character-enhancer prompt
//      emits `BLOCKED: <reason>` on unsafe input, and Luma has a
//      non-disableable moderation backstop downstream).
//   3. Enhance via Claude Opus 4.7 through the bridge subprocess.
//   4. Return enhanced brief. No D1 write — the result is round-tripped to
//      the client and reused on /api/reel/generate.

import {
  type ReelEnv,
  MAX_RAW_CHARACTER_CHARS,
  enhanceCharacterAnthropic,
  errorResponse,
  jsonResponse,
  moderationFlagged,
} from "../../_reel-shared.ts";

type Body = { character?: string };

export const onRequestPost: PagesFunction<ReelEnv> = async (ctx) => {
  let body: Body;
  try {
    body = (await ctx.request.json()) as Body;
  } catch {
    return errorResponse(400, "bad_json", "Body must be JSON");
  }

  const raw = (body.character ?? "").trim();
  if (!raw) return errorResponse(400, "missing_character", "Character description is required");
  if (raw.length < 4) {
    return errorResponse(400, "character_too_short", "Character description is too short");
  }
  if (raw.length > MAX_RAW_CHARACTER_CHARS) {
    return errorResponse(
      400,
      "character_too_long",
      `Character description must be <= ${MAX_RAW_CHARACTER_CHARS} characters`,
    );
  }

  if (!ctx.env.REEL_BRIDGE_URL || !ctx.env.REEL_BRIDGE_TOKEN) {
    return errorResponse(503, "service_unavailable", "Character enhancement is not yet configured");
  }

  const mod = await moderationFlagged(raw, ctx.env);
  if (mod.flagged) {
    return errorResponse(
      422,
      "moderation_blocked",
      `That description was blocked by safety filters (${mod.reason}).`,
    );
  }

  try {
    const result = await enhanceCharacterAnthropic(raw, ctx.env);
    if (result.blocked || !result.enhanced) {
      return errorResponse(422, "policy_blocked", result.blockReason ?? "Description blocked by policy");
    }
    return jsonResponse({ ok: true, raw, enhanced: result.enhanced });
  } catch (e) {
    console.error("enhance-character failed:", (e as Error).message);
    return errorResponse(502, "enhance_failed", "Character enhancement service failed; try again.");
  }
};
