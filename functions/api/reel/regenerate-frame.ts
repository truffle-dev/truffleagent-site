// POST /api/reel/regenerate-frame
// Body: { piece_id: string, frame_index: number, hint?: string }
//
// Single-frame regenerate with an optional natural-language hint. The hint
// is appended to the existing visual_prompt; we do NOT pass through Anthropic
// re-enhancement to keep the regenerate flow Luma-only and key-light.
//
// Authorization: visitor_hash on the request must match piece.visitor_hash.
// Only the original creator can regenerate their own frames.
//
// Side effects:
//   1. Resolve piece + frame.
//   2. Validate visitor + piece.completed-or-failed state + non-sentinel frame.
//   3. Build new visual_prompt = original + (hint ? " — " + hint : "").
//   4. Dispatch Luma image_edit (source.url = master, prompt = new).
//   5. Update frame row: status='in_flight', new luma_id, attempts=0 (fresh
//      user-initiated cycle), clear image_url + completed_at + inspection_log.
//   6. Flip piece.status back to 'frames_in_flight' so the status endpoint
//      will poll + inspect this frame on the next call.
//   7. Return { ok, frame_index, new_luma_id }.

import {
  type ReelEnv,
  errorResponse,
  jsonResponse,
  lumaSubmitImageEdit,
  visitorHash,
} from "../../_reel-shared.ts";

type Body = {
  piece_id?: string;
  frame_index?: number;
  hint?: string;
};

const PIECE_ID_RE = /^rl_[A-Za-z0-9]{1,22}$/;
const MAX_HINT_CHARS = 240;

type PieceRow = {
  id: string;
  master_ref_url: string | null;
  status: string;
  visitor_hash: string;
};

type FrameRow = {
  piece_id: string;
  frame_index: number;
  visual_prompt: string;
  status: string;
};

export const onRequestPost: PagesFunction<ReelEnv> = async (ctx) => {
  let body: Body;
  try {
    body = (await ctx.request.json()) as Body;
  } catch {
    return errorResponse(400, "bad_json", "Body must be JSON");
  }

  const pieceId = (body.piece_id ?? "").trim();
  const frameIndex = Number.isFinite(body.frame_index) ? Math.floor(body.frame_index as number) : -1;
  const hint = (body.hint ?? "").trim();

  if (!pieceId || !PIECE_ID_RE.test(pieceId)) {
    return errorResponse(400, "bad_id", "piece_id must look like rl_<id>");
  }
  if (frameIndex < 1) {
    return errorResponse(400, "bad_frame_index", "frame_index must be >= 1 (sentinel frame is not regeneratable)");
  }
  if (hint.length > MAX_HINT_CHARS) {
    return errorResponse(400, "hint_too_long", `hint must be at most ${MAX_HINT_CHARS} characters`);
  }
  if (!ctx.env.LUMA_AGENTS_API_KEY) {
    return errorResponse(503, "service_unavailable", "Image service is not yet configured");
  }

  const piece = await ctx.env.DB
    .prepare(`SELECT id, master_ref_url, status, visitor_hash FROM reel_pieces WHERE id = ?`)
    .bind(pieceId)
    .first<PieceRow>();
  if (!piece) return errorResponse(404, "not_found", "No piece with that id");
  if (!piece.master_ref_url) {
    return errorResponse(409, "no_master", "This piece has no master reference yet; wait for it to finish");
  }
  if (piece.status !== "completed" && piece.status !== "failed" && piece.status !== "frames_in_flight") {
    return errorResponse(
      409,
      "piece_not_regeneratable",
      `Piece status is ${piece.status}; regenerate is only allowed when piece is completed, failed, or in frames phase`,
    );
  }

  const visitor = await visitorHash(ctx.request, ctx.env);
  if (visitor !== piece.visitor_hash) {
    return errorResponse(403, "not_owner", "Only the original creator can regenerate frames on this piece");
  }

  const frame = await ctx.env.DB
    .prepare(`SELECT piece_id, frame_index, visual_prompt, status FROM reel_frames WHERE piece_id = ? AND frame_index = ?`)
    .bind(pieceId, frameIndex)
    .first<FrameRow>();
  if (!frame) return errorResponse(404, "frame_not_found", "No frame at that index");
  if (frame.status === "in_flight" || frame.status === "inspecting") {
    return errorResponse(
      409,
      "frame_in_flight",
      `Frame status is ${frame.status}; wait for the current cycle to finish before regenerating`,
    );
  }

  const newPrompt = hint ? `${frame.visual_prompt} — ${hint}` : frame.visual_prompt;
  const masterAbs = new URL(piece.master_ref_url, ctx.request.url).toString();

  let lumaId: string;
  try {
    const luma = await lumaSubmitImageEdit(newPrompt, masterAbs, ctx.env);
    lumaId = luma.id;
  } catch (e) {
    console.error("luma regenerate submit failed:", (e as Error).message);
    return errorResponse(502, "luma_submit_failed", "Image service rejected the regenerate; try a shorter hint or try again later.");
  }

  try {
    await ctx.env.DB.batch([
      ctx.env.DB
        .prepare(
          `UPDATE reel_frames
             SET visual_prompt = ?,
                 luma_generation_id = ?,
                 status = 'in_flight',
                 attempts = 0,
                 image_url = NULL,
                 completed_at = NULL,
                 inspection_log = NULL,
                 latency_ms = NULL,
                 dispatched_at_ms = ?
           WHERE piece_id = ? AND frame_index = ?`,
        )
        .bind(newPrompt, lumaId, Date.now(), pieceId, frameIndex),
      ctx.env.DB
        .prepare(
          `UPDATE reel_pieces SET status = 'frames_in_flight', completed_at = NULL WHERE id = ?`,
        )
        .bind(pieceId),
      ctx.env.DB
        .prepare(
          `INSERT INTO reel_prompts (piece_id, kind, content, meta) VALUES (?, 'frame_prompt', ?, ?)`,
        )
        .bind(pieceId, newPrompt, JSON.stringify({ frame_index: frameIndex, action: "regenerate", hint: hint || null })),
    ]);
  } catch (e) {
    console.error("d1 regenerate update failed:", (e as Error).message);
    return errorResponse(500, "db_update_failed", "Could not record the regenerate; please try again.");
  }

  return jsonResponse({
    ok: true,
    piece_id: pieceId,
    frame_index: frameIndex,
    new_luma_id: lumaId,
    new_visual_prompt: newPrompt,
    status: "in_flight",
    poll: `/api/reel/status/${pieceId}`,
  });
};
