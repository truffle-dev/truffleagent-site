// POST /api/reel/generate
// Body: {
//   character_raw: string,
//   character_enhanced: string,
//   story_raw: string,
//   story_enhanced: string,        // logline from beat_sheet
//   beat_sheet: { title, logline, panels: [...] },
//   mode: "comic" | "gif",
//   frame_count: number
// }
// Returns: { ok: true, id, status, draft_url } | { ok: false, error }
//
// Steps:
//   1. Validate body shape, frame_count vs panels length, mode.
//   2. Visitor hash + daily quota check (increment on success).
//   3. Final safety pass (no-op stub; enhancer prompts gate on BLOCKED,
//      Luma backstops downstream).
//   4. Mint piece_id, mint slug from beat_sheet.title + short suffix.
//   5. Submit Master Reference Asset to Luma (`type: image` with character_enhanced).
//   6. Insert reel_pieces row (status=master_in_flight, master luma id stored on a placeholder frame).
//   7. Insert N reel_frames rows (status=queued, visual_prompt per panel).
//   8. Insert reel_prompts rows for character_raw, character_enhanced,
//      story_raw, story_enhanced, beat_sheet.
//   9. Return { id } — client redirects to /reel/draft/<id>/ and polls
//      /api/reel/status/<id> which drives the rest of the pipeline.

import {
  type ReelEnv,
  type ReelMode,
  COST_PER_LUMA_UNI1,
  DAILY_QUOTA_PIECES,
  MAX_FRAMES,
  MIN_FRAMES,
  VALID_MODES,
  checkAndIncrementPieceQuota,
  checkInFlightForVisitor,
  errorResponse,
  jsonResponse,
  lumaSubmitImage,
  moderationFlagged,
  newPieceId,
  resolveVoice,
  slugify,
  verifyTurnstile,
  visitorHash,
} from "../../_reel-shared.ts";

type Panel = { index: number; beat: string; visual_prompt: string };
type BeatSheet = { title: string; logline: string; panels: Panel[] };
type Body = {
  character_raw?: string;
  character_enhanced?: string;
  story_raw?: string;
  story_enhanced?: string;
  beat_sheet?: BeatSheet;
  mode?: string;
  frame_count?: number;
  voice_id?: string;
  turnstile_token?: string;
};

function isPanel(x: unknown): x is Panel {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Record<string, unknown>;
  return typeof p.index === "number" && typeof p.beat === "string" && typeof p.visual_prompt === "string";
}

function isBeatSheet(x: unknown): x is BeatSheet {
  if (typeof x !== "object" || x === null) return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.title === "string" &&
    typeof b.logline === "string" &&
    Array.isArray(b.panels) &&
    b.panels.every(isPanel)
  );
}

export const onRequestPost: PagesFunction<ReelEnv> = async (ctx) => {
  let body: Body;
  try {
    body = (await ctx.request.json()) as Body;
  } catch {
    return errorResponse(400, "bad_json", "Body must be JSON");
  }

  const tsVerify = await verifyTurnstile(
    body.turnstile_token ?? "",
    ctx.request.headers.get("CF-Connecting-IP"),
    ctx.env,
  );
  if (!tsVerify.success) {
    return errorResponse(
      403,
      "turnstile_failed",
      `Bot challenge failed (${tsVerify.reason ?? "unknown"}). Refresh the page and try again.`,
    );
  }

  const characterRaw = (body.character_raw ?? "").trim();
  const characterEnhanced = (body.character_enhanced ?? "").trim();
  const storyRaw = (body.story_raw ?? "").trim();
  const storyEnhanced = (body.story_enhanced ?? "").trim();
  const mode = (body.mode ?? "").trim() as ReelMode;
  const frameCount = Number.isFinite(body.frame_count) ? Math.floor(body.frame_count as number) : -1;

  if (!characterRaw || !characterEnhanced) {
    return errorResponse(400, "missing_character", "character_raw and character_enhanced are required");
  }
  if (!storyRaw || !storyEnhanced) {
    return errorResponse(400, "missing_story", "story_raw and story_enhanced are required");
  }
  if (!VALID_MODES.includes(mode)) {
    return errorResponse(400, "invalid_mode", `mode must be one of ${VALID_MODES.join(", ")}`);
  }
  if (frameCount < MIN_FRAMES || frameCount > MAX_FRAMES) {
    return errorResponse(
      400,
      "frame_count_out_of_range",
      `frame_count must be between ${MIN_FRAMES} and ${MAX_FRAMES}`,
    );
  }
  if (!isBeatSheet(body.beat_sheet)) {
    return errorResponse(400, "invalid_beat_sheet", "beat_sheet must be { title, logline, panels[] }");
  }
  const beatSheet = body.beat_sheet;
  if (beatSheet.panels.length !== frameCount) {
    return errorResponse(
      400,
      "beat_sheet_panel_count_mismatch",
      `beat_sheet.panels.length=${beatSheet.panels.length} does not match frame_count=${frameCount}`,
    );
  }
  if (!ctx.env.LUMA_AGENTS_API_KEY) {
    return errorResponse(503, "service_unavailable", "Image service is not yet configured");
  }

  // Optional voice opt-in. Empty/missing voice_id means narration is off.
  // Unknown voice_id is a 400 — fail fast rather than silently dropping.
  const voiceRaw = (body.voice_id ?? "").trim();
  const voice = voiceRaw ? resolveVoice(voiceRaw) : null;
  if (voiceRaw && !voice) {
    return errorResponse(400, "invalid_voice_id", `voice_id "${voiceRaw}" is not a known narration voice`);
  }
  const narrationVoiceId = voice?.id ?? null;
  const narrationStatus = voice ? "pending" : null;

  const visitor = await visitorHash(ctx.request, ctx.env);

  // Refuse a second concurrent submission. The check runs BEFORE quota
  // increment so a stuck in-flight piece doesn't consume daily allowance.
  const inFlight = await checkInFlightForVisitor(ctx.env, visitor);
  if (inFlight.inFlight) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "generation_in_flight",
          message: `You already have a reel in flight. Wait for it to finish, or open ${inFlight.draftUrl} to track it.`,
          piece_id: inFlight.pieceId,
          draft_url: inFlight.draftUrl,
        },
      },
      { status: 429 },
    );
  }

  const quota = await checkAndIncrementPieceQuota(ctx.env, visitor);
  if (quota.over) {
    return errorResponse(
      429,
      "daily_quota_exceeded",
      `Daily quota of ${DAILY_QUOTA_PIECES} reels reached. Come back tomorrow.`,
    );
  }

  // Final safety pass on both raw inputs. Currently a no-op stub —
  // see _reel-shared.ts moderationFlagged. Left in place as a hook for
  // any future non-OpenAI safety filter.
  for (const [label, text] of [
    ["character", characterRaw],
    ["story", storyRaw],
  ] as const) {
    const mod = await moderationFlagged(text, ctx.env);
    if (mod.flagged) {
      return errorResponse(
        422,
        "moderation_blocked",
        `Your ${label} was blocked by safety filters (${mod.reason}).`,
      );
    }
  }

  const pieceId = newPieceId();
  const slug = slugify(beatSheet.title, pieceId.slice(-6));

  // Dispatch Master Reference Asset to Luma. The character_enhanced brief
  // already ends with a framing sentence (rendering style + camera).
  let masterGenId: string;
  try {
    const luma = await lumaSubmitImage(characterEnhanced, ctx.env, {
      model: "uni-1",
      aspect_ratio: "1:1",
    });
    masterGenId = luma.id;
  } catch (e) {
    console.error("luma master submit failed:", (e as Error).message);
    return errorResponse(502, "luma_submit_failed", "Image service rejected the master reference; try a simpler character description.");
  }

  // Insert piece row, all N frame rows, and prompt log rows in one batch.
  const insertPiece = ctx.env.DB
    .prepare(
      `INSERT INTO reel_pieces
         (id, slug, character_raw, character_enhanced, story_raw, story_enhanced,
          beat_sheet_json, mode, frame_count, master_ref_url, status,
          visitor_hash, visible, cost_usd,
          narration_voice_id, narration_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'master_in_flight', ?, 1, ?, ?, ?)`,
    )
    .bind(
      pieceId,
      slug,
      characterRaw,
      characterEnhanced,
      storyRaw,
      storyEnhanced,
      JSON.stringify(beatSheet),
      mode,
      frameCount,
      visitor,
      COST_PER_LUMA_UNI1, // master so far
      narrationVoiceId,
      narrationStatus,
    );

  // Encode the master luma_generation_id on frame_index=0 as a sentinel.
  // The actual user-visible frames start at frame_index=1.
  const insertMasterSentinel = ctx.env.DB
    .prepare(
      `INSERT INTO reel_frames
         (piece_id, frame_index, visual_prompt, luma_generation_id, status, attempts)
       VALUES (?, 0, '<master reference>', ?, 'in_flight', 1)`,
    )
    .bind(pieceId, masterGenId);

  const insertFrames = beatSheet.panels.map((panel) =>
    ctx.env.DB
      .prepare(
        `INSERT INTO reel_frames
           (piece_id, frame_index, visual_prompt, status, attempts)
         VALUES (?, ?, ?, 'queued', 0)`,
      )
      .bind(pieceId, panel.index, panel.visual_prompt),
  );

  const insertPrompts = [
    ["character_raw", characterRaw],
    ["character_enhanced", characterEnhanced],
    ["story_raw", storyRaw],
    ["story_enhanced", storyEnhanced],
    ["beat_sheet", JSON.stringify(beatSheet)],
  ].map(([kind, content]) =>
    ctx.env.DB
      .prepare(
        `INSERT INTO reel_prompts (piece_id, kind, content) VALUES (?, ?, ?)`,
      )
      .bind(pieceId, kind, content),
  );

  try {
    await ctx.env.DB.batch([insertPiece, insertMasterSentinel, ...insertFrames, ...insertPrompts]);
  } catch (e) {
    console.error("d1 batch insert failed:", (e as Error).message);
    return errorResponse(500, "db_insert_failed", "Could not record the new reel; please try again.");
  }

  return jsonResponse({
    ok: true,
    id: pieceId,
    status: "master_in_flight",
    draft_url: `/reel/draft/${pieceId}/`,
    slug,
    quota_remaining: quota.remaining,
  });
};
