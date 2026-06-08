// GET /api/reel/status/<id>
// Returns the current state of a reel piece. Drives the multi-stage
// pipeline forward by at most one batch per call:
//   1. master_in_flight: poll Luma master, on completion put to R2 and
//      dispatch first FRAME_PARALLELISM frame edits.
//   2. frames_in_flight: poll Luma for each in-flight frame, download +
//      put completed ones to R2, dispatch Opus inspection for fresh
//      downloads, dispatch new queued frames if budget allows, mark
//      piece completed when all frames accepted.
//
// Always idempotent. Safe to call concurrently — a second concurrent
// call sees the updated D1 rows and skips already-handled work.

import {
  type LumaGeneration,
  type ReelEnv,
  type ReelFrameStatus,
  COST_PER_LUMA_UNI1,
  COST_PER_OPUS_INSPECTION,
  FRAME_PARALLELISM,
  MAX_FRAME_ATTEMPTS,
  PIECE_ID_RE,
  errorResponse,
  fetchImageBytes,
  inspectFrameAnthropic,
  jsonResponse,
  lumaGet,
  lumaSubmitImageEdit,
} from "../../../_reel-shared.ts";

type PieceRow = {
  id: string;
  slug: string;
  character_raw: string;
  character_enhanced: string | null;
  story_raw: string;
  story_enhanced: string | null;
  beat_sheet_json: string | null;
  mode: "comic" | "gif";
  frame_count: number;
  master_ref_url: string | null;
  status: string;
  visible: number;
  error_log: string | null;
  cost_usd: number;
  created_at: string;
  completed_at: string | null;
};

type FrameRow = {
  piece_id: string;
  frame_index: number;
  visual_prompt: string;
  luma_generation_id: string | null;
  status: ReelFrameStatus;
  image_url: string | null;
  inspection_log: string | null;
  attempts: number;
  cost_usd: number;
  latency_ms: number | null;
  completed_at: string | null;
};

function nowIso(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function appendError(prev: string | null, line: string): string {
  const ts = new Date().toISOString();
  const tagged = `[${ts}] ${line}`;
  return prev ? `${prev}\n${tagged}` : tagged;
}

// On Luma dispatch failure, increment attempts and terminalize if either
// (a) attempts reached MAX_FRAME_ATTEMPTS, or (b) the failure is a permanent
// rejection (content_moderated) where retrying the same prompt is pointless.
// Without this, content-moderated frames re-dispatch on every status call and
// the piece never reaches a terminal state.
async function handleDispatchFailure(
  env: ReelEnv,
  pieceId: string,
  frame: FrameRow,
  err: Error,
  source: "retry_dispatch" | "new_dispatch",
  note: (line: string) => void,
): Promise<void> {
  const msg = err.message;
  const permanent = /content_moderated/i.test(msg);
  const nextAttempts = frame.attempts + 1;
  const terminal = permanent || nextAttempts >= MAX_FRAME_ATTEMPTS;
  if (terminal) {
    const reason = permanent
      ? `content_moderated (permanent): ${msg.slice(0, 200)}`
      : `dispatch_failed_after_${nextAttempts}_attempts: ${msg.slice(0, 200)}`;
    await env.DB
      .prepare(
        "UPDATE reel_frames SET status='failed', attempts=?, inspection_log=? WHERE piece_id=? AND frame_index=?",
      )
      .bind(nextAttempts, reason, pieceId, frame.frame_index)
      .run();
    note(
      `frame_terminal_dispatch_failed frame=${frame.frame_index} via=${source} ${permanent ? "permanent_content_moderated" : `after_${nextAttempts}_attempts`}: ${msg.slice(0, 120)}`,
    );
  } else {
    await env.DB
      .prepare(
        "UPDATE reel_frames SET attempts=? WHERE piece_id=? AND frame_index=?",
      )
      .bind(nextAttempts, pieceId, frame.frame_index)
      .run();
    note(`${source} frame=${frame.frame_index} attempt=${nextAttempts}_of_${MAX_FRAME_ATTEMPTS}: ${msg.slice(0, 160)}`);
  }
}

async function loadPiece(env: ReelEnv, id: string): Promise<PieceRow | null> {
  return env.DB
    .prepare(
      `SELECT id, slug, character_raw, character_enhanced, story_raw, story_enhanced,
              beat_sheet_json, mode, frame_count, master_ref_url, status, visible,
              error_log, cost_usd, created_at, completed_at
         FROM reel_pieces WHERE id = ?`,
    )
    .bind(id)
    .first<PieceRow>();
}

async function loadFrames(env: ReelEnv, pieceId: string): Promise<FrameRow[]> {
  const result = await env.DB
    .prepare(
      `SELECT piece_id, frame_index, visual_prompt, luma_generation_id, status,
              image_url, inspection_log, attempts, cost_usd, latency_ms, completed_at
         FROM reel_frames WHERE piece_id = ? ORDER BY frame_index ASC`,
    )
    .bind(pieceId)
    .all<FrameRow>();
  return result.results ?? [];
}

function imageUrlFor(piece: PieceRow, frameIndex: number, isMaster: boolean): string {
  if (isMaster) return `/i-reel/master/${piece.id}.png`;
  return `/i-reel/frame/${piece.id}/${frameIndex}.png`;
}

function r2KeyFor(piece: PieceRow, frameIndex: number, isMaster: boolean): string {
  if (isMaster) return `master/${piece.id}.png`;
  return `frame/${piece.id}/${frameIndex}.png`;
}

function pickLumaUrl(luma: LumaGeneration): string | null {
  return luma.output?.[0]?.url ?? null;
}

function snapshot(piece: PieceRow, frames: FrameRow[]) {
  const userFrames = frames
    .filter((f) => f.frame_index >= 1)
    .map((f) => ({
      index: f.frame_index,
      status: f.status,
      visual_prompt: f.visual_prompt,
      image_url: f.image_url,
      attempts: f.attempts,
      inspection_log: f.inspection_log,
    }));
  return {
    ok: true,
    id: piece.id,
    slug: piece.slug,
    status: piece.status,
    mode: piece.mode,
    frame_count: piece.frame_count,
    master_ref_url: piece.master_ref_url,
    character_enhanced: piece.character_enhanced,
    story_enhanced: piece.story_enhanced,
    error_log: piece.error_log,
    created_at: piece.created_at,
    completed_at: piece.completed_at,
    cost_usd: piece.cost_usd,
    frames: userFrames,
  };
}

export const onRequestGet: PagesFunction<ReelEnv, "id"> = async (ctx) => {
  const id = ctx.params.id;
  if (typeof id !== "string" || !PIECE_ID_RE.test(id)) {
    return errorResponse(400, "bad_id", "Bad piece id");
  }

  let piece = await loadPiece(ctx.env, id);
  if (!piece) return errorResponse(404, "not_found", "No such piece");

  let frames = await loadFrames(ctx.env, id);

  // Soft-error accumulator. Lines pushed here are flushed to
  // reel_pieces.error_log in a single UPDATE before any return that
  // doesn't already write the column. The draft page polls this field
  // and surfaces it under the agent log so the user can see the same
  // pipeline failures the server logs do (roadmap 1.6.3).
  const softErrors: string[] = [];
  const noteSoftError = (line: string): void => {
    softErrors.push(`[${new Date().toISOString()}] ${line.slice(0, 200)}`);
  };
  const flushSoftErrors = async (): Promise<void> => {
    if (softErrors.length === 0) return;
    const next = piece.error_log
      ? `${piece.error_log}\n${softErrors.join("\n")}`
      : softErrors.join("\n");
    try {
      await ctx.env.DB
        .prepare("UPDATE reel_pieces SET error_log=? WHERE id=?")
        .bind(next, id)
        .run();
      piece = { ...piece, error_log: next };
    } catch (e) {
      console.error("error_log flush failed:", (e as Error).message);
    }
    softErrors.length = 0;
  };

  // Terminal states short-circuit.
  if (piece.status === "completed" || piece.status === "failed") {
    return jsonResponse(snapshot(piece, frames));
  }

  // -------------------- Master phase --------------------
  if (piece.status === "master_in_flight") {
    const masterFrame = frames.find((f) => f.frame_index === 0);
    if (!masterFrame || !masterFrame.luma_generation_id) {
      const err = appendError(piece.error_log, "master_sentinel_missing");
      await ctx.env.DB
        .prepare("UPDATE reel_pieces SET status='failed', error_log=? WHERE id=?")
        .bind(err, id)
        .run();
      return jsonResponse(snapshot({ ...piece, status: "failed", error_log: err }, frames));
    }

    let luma: LumaGeneration;
    try {
      luma = await lumaGet(masterFrame.luma_generation_id, ctx.env);
    } catch (e) {
      noteSoftError(`luma_master_poll: ${(e as Error).message}`);
      await flushSoftErrors();
      return jsonResponse(snapshot(piece, frames));
    }

    if (luma.state === "queued" || luma.state === "processing") {
      return jsonResponse(snapshot(piece, frames));
    }

    if (luma.state === "failed") {
      const err = appendError(piece.error_log, `luma_master_failed: ${luma.failure_reason ?? "unknown"}`);
      await ctx.env.DB.batch([
        ctx.env.DB.prepare("UPDATE reel_pieces SET status='failed', error_log=? WHERE id=?").bind(err, id),
        ctx.env.DB
          .prepare(
            "UPDATE reel_frames SET status='failed', completed_at=datetime('now') WHERE piece_id=? AND frame_index=0",
          )
          .bind(id),
      ]);
      piece = { ...piece, status: "failed", error_log: err };
      frames = await loadFrames(ctx.env, id);
      return jsonResponse(snapshot(piece, frames));
    }

    // Completed: download + put to R2 + set master_ref_url.
    const srcUrl = pickLumaUrl(luma);
    if (!srcUrl) {
      const err = appendError(piece.error_log, "master_no_output_url");
      await ctx.env.DB
        .prepare("UPDATE reel_pieces SET status='failed', error_log=? WHERE id=?")
        .bind(err, id)
        .run();
      return jsonResponse(snapshot({ ...piece, status: "failed", error_log: err }, frames));
    }

    try {
      const img = await fetchImageBytes(srcUrl);
      const r2Key = r2KeyFor(piece, 0, true);
      await ctx.env.REEL_BUCKET.put(r2Key, img.bytes, {
        httpMetadata: {
          contentType: img.contentType,
          cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: { piece_id: piece.id, kind: "master", luma_id: masterFrame.luma_generation_id },
      });
      const masterPublicUrl = imageUrlFor(piece, 0, true);

      // Pick first FRAME_PARALLELISM queued frames and dispatch them.
      const queued = frames.filter((f) => f.frame_index >= 1 && f.status === "queued");
      const toLaunch = queued.slice(0, FRAME_PARALLELISM);
      const launched: Array<{ frame_index: number; luma_id: string }> = [];
      for (const frame of toLaunch) {
        try {
          const lumaEdit = await lumaSubmitImageEdit(
            frame.visual_prompt,
            // Luma needs an externally fetchable URL. We use the absolute
            // /i-reel/ URL on our origin so Luma fetches from our R2.
            new URL(masterPublicUrl, ctx.request.url).toString(),
            ctx.env,
            { model: "uni-1" },
          );
          launched.push({ frame_index: frame.frame_index, luma_id: lumaEdit.id });
        } catch (e) {
          noteSoftError(`luma_frame_dispatch frame=${frame.frame_index}: ${(e as Error).message}`);
        }
      }

      const updates = [
        ctx.env.DB
          .prepare(
            "UPDATE reel_pieces SET master_ref_url=?, status='frames_in_flight', cost_usd=cost_usd+? WHERE id=?",
          )
          .bind(masterPublicUrl, 0, id),
        ctx.env.DB
          .prepare(
            "UPDATE reel_frames SET status='accepted', image_url=?, completed_at=datetime('now') WHERE piece_id=? AND frame_index=0",
          )
          .bind(masterPublicUrl, id),
      ];
      const dispatchedAtMs = Date.now();
      for (const l of launched) {
        updates.push(
          ctx.env.DB
            .prepare(
              "UPDATE reel_frames SET status='in_flight', luma_generation_id=?, attempts=attempts+1, cost_usd=cost_usd+?, dispatched_at_ms=COALESCE(dispatched_at_ms, ?) WHERE piece_id=? AND frame_index=?",
            )
            .bind(l.luma_id, COST_PER_LUMA_UNI1, dispatchedAtMs, id, l.frame_index),
        );
      }
      await ctx.env.DB.batch(updates);

      piece = await loadPiece(ctx.env, id) ?? piece;
      frames = await loadFrames(ctx.env, id);
      await flushSoftErrors();
      return jsonResponse(snapshot(piece, frames));
    } catch (e) {
      console.error("master post-luma failed:", (e as Error).message);
      const err = appendError(piece.error_log, `master_post_luma: ${(e as Error).message.slice(0, 120)}`);
      await ctx.env.DB
        .prepare("UPDATE reel_pieces SET status='failed', error_log=? WHERE id=?")
        .bind(err, id)
        .run();
      return jsonResponse(snapshot({ ...piece, status: "failed", error_log: err }, frames));
    }
  }

  // -------------------- Frames phase --------------------
  if (piece.status !== "frames_in_flight") {
    await flushSoftErrors();
    return jsonResponse(snapshot(piece, frames));
  }

  if (!piece.master_ref_url) {
    const err = appendError(piece.error_log, "missing_master_ref_url_in_frames_phase");
    await ctx.env.DB
      .prepare("UPDATE reel_pieces SET status='failed', error_log=? WHERE id=?")
      .bind(err, id)
      .run();
    return jsonResponse(snapshot({ ...piece, status: "failed", error_log: err }, frames));
  }

  const masterAbsoluteUrl = new URL(piece.master_ref_url, ctx.request.url).toString();
  const userFrames = frames.filter((f) => f.frame_index >= 1);

  // 1. Poll in-flight Luma frames; download completed ones.
  for (const frame of userFrames) {
    if (frame.status !== "in_flight") continue;
    if (!frame.luma_generation_id) continue;
    let luma: LumaGeneration;
    try {
      luma = await lumaGet(frame.luma_generation_id, ctx.env);
    } catch (e) {
      noteSoftError(`luma_frame_poll frame=${frame.frame_index}: ${(e as Error).message}`);
      continue;
    }
    if (luma.state === "queued" || luma.state === "processing") continue;

    if (luma.state === "failed") {
      // Retry budget.
      if (frame.attempts >= MAX_FRAME_ATTEMPTS) {
        noteSoftError(`frame_terminal_failed frame=${frame.frame_index} reason=luma_failed_after_${frame.attempts}_attempts: ${luma.failure_reason ?? "unknown"}`);
        await ctx.env.DB
          .prepare(
            "UPDATE reel_frames SET status='failed', completed_at=datetime('now'), latency_ms=COALESCE(?-dispatched_at_ms, latency_ms) WHERE piece_id=? AND frame_index=?",
          )
          .bind(Date.now(), id, frame.frame_index)
          .run();
      } else {
        noteSoftError(`frame_luma_retrying frame=${frame.frame_index} attempt=${frame.attempts}: ${luma.failure_reason ?? "unknown"}`);
        await ctx.env.DB
          .prepare(
            "UPDATE reel_frames SET status='rejected_retrying' WHERE piece_id=? AND frame_index=?",
          )
          .bind(id, frame.frame_index)
          .run();
      }
      continue;
    }

    // Completed at Luma. Download → R2 → mark for inspection.
    const srcUrl = pickLumaUrl(luma);
    if (!srcUrl) {
      await ctx.env.DB
        .prepare(
          "UPDATE reel_frames SET status='rejected_retrying' WHERE piece_id=? AND frame_index=?",
        )
        .bind(id, frame.frame_index)
        .run();
      continue;
    }
    try {
      const img = await fetchImageBytes(srcUrl);
      const r2Key = r2KeyFor(piece, frame.frame_index, false);
      await ctx.env.REEL_BUCKET.put(r2Key, img.bytes, {
        httpMetadata: {
          contentType: img.contentType,
          cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: { piece_id: piece.id, frame: String(frame.frame_index), luma_id: frame.luma_generation_id },
      });
      const publicUrl = imageUrlFor(piece, frame.frame_index, false);
      await ctx.env.DB
        .prepare(
          "UPDATE reel_frames SET status='inspecting', image_url=?, completed_at=datetime('now') WHERE piece_id=? AND frame_index=?",
        )
        .bind(publicUrl, id, frame.frame_index)
        .run();
    } catch (e) {
      noteSoftError(`frame_download frame=${frame.frame_index}: ${(e as Error).message}`);
    }
  }

  // Reload frames after Luma poll pass.
  frames = await loadFrames(ctx.env, id);

  // 2. Inspect one ready-for-inspection frame per call (Opus budget).
  const toInspect = frames.filter((f) => f.frame_index >= 1 && f.status === "inspecting" && f.image_url).slice(0, 1);
  for (const frame of toInspect) {
    try {
      const frameAbsolute = new URL(frame.image_url!, ctx.request.url).toString();
      const verdict = await inspectFrameAnthropic({
        masterUrl: masterAbsoluteUrl,
        frameUrl: frameAbsolute,
        env: ctx.env,
      });
      const log = appendError(
        frame.inspection_log,
        `inspect drift=${verdict.drift} accept=${verdict.accept} reason=${verdict.reason.slice(0, 160)}`,
      );
      if (verdict.accept) {
        await ctx.env.DB
          .prepare(
            "UPDATE reel_frames SET status='accepted', inspection_log=?, cost_usd=cost_usd+?, latency_ms=COALESCE(?-dispatched_at_ms, latency_ms) WHERE piece_id=? AND frame_index=?",
          )
          .bind(log, COST_PER_OPUS_INSPECTION, Date.now(), id, frame.frame_index)
          .run();
      } else {
        // Reject. Retry budget.
        if (frame.attempts >= MAX_FRAME_ATTEMPTS) {
          noteSoftError(`frame_terminal_failed frame=${frame.frame_index} reason=opus_rejected_after_${frame.attempts}_attempts drift=${verdict.drift}: ${verdict.reason.slice(0, 120)}`);
          await ctx.env.DB
            .prepare(
              "UPDATE reel_frames SET status='failed', inspection_log=?, cost_usd=cost_usd+?, latency_ms=COALESCE(?-dispatched_at_ms, latency_ms) WHERE piece_id=? AND frame_index=?",
            )
            .bind(log, COST_PER_OPUS_INSPECTION, Date.now(), id, frame.frame_index)
            .run();
        } else {
          noteSoftError(`frame_opus_retrying frame=${frame.frame_index} attempt=${frame.attempts} drift=${verdict.drift}: ${verdict.reason.slice(0, 120)}`);
          await ctx.env.DB
            .prepare(
              "UPDATE reel_frames SET status='rejected_retrying', inspection_log=?, cost_usd=cost_usd+? WHERE piece_id=? AND frame_index=?",
            )
            .bind(log, COST_PER_OPUS_INSPECTION, id, frame.frame_index)
            .run();
        }
      }
    } catch (e) {
      noteSoftError(`opus_inspect frame=${frame.frame_index}: ${(e as Error).message}`);
    }
  }

  // 3. Dispatch retry frames (rejected_retrying) — keep budget.
  frames = await loadFrames(ctx.env, id);
  const inFlightCount = frames.filter((f) => f.frame_index >= 1 && f.status === "in_flight").length;
  const dispatchBudget = Math.max(0, FRAME_PARALLELISM - inFlightCount);
  const retryQueue = frames.filter((f) => f.frame_index >= 1 && f.status === "rejected_retrying").slice(0, dispatchBudget);
  const launchedRetry: Array<{ frame_index: number; luma_id: string }> = [];
  for (const frame of retryQueue) {
    try {
      const lumaEdit = await lumaSubmitImageEdit(
        frame.visual_prompt,
        masterAbsoluteUrl,
        ctx.env,
        { model: "uni-1" },
      );
      launchedRetry.push({ frame_index: frame.frame_index, luma_id: lumaEdit.id });
    } catch (e) {
      await handleDispatchFailure(ctx.env, id, frame, e as Error, "retry_dispatch", noteSoftError);
    }
  }
  if (launchedRetry.length > 0) {
    const dispatchedAtMs = Date.now();
    await ctx.env.DB.batch(
      launchedRetry.map((l) =>
        ctx.env.DB
          .prepare(
            "UPDATE reel_frames SET status='in_flight', luma_generation_id=?, attempts=attempts+1, cost_usd=cost_usd+?, dispatched_at_ms=COALESCE(dispatched_at_ms, ?) WHERE piece_id=? AND frame_index=?",
          )
          .bind(l.luma_id, COST_PER_LUMA_UNI1, dispatchedAtMs, id, l.frame_index),
      ),
    );
  }

  // 4. Dispatch new queued frames (the ones not yet started) if budget remains.
  frames = await loadFrames(ctx.env, id);
  const inFlightCount2 = frames.filter((f) => f.frame_index >= 1 && f.status === "in_flight").length;
  const remainingBudget = Math.max(0, FRAME_PARALLELISM - inFlightCount2);
  const newQueue = frames.filter((f) => f.frame_index >= 1 && f.status === "queued").slice(0, remainingBudget);
  const launchedNew: Array<{ frame_index: number; luma_id: string }> = [];
  for (const frame of newQueue) {
    try {
      const lumaEdit = await lumaSubmitImageEdit(
        frame.visual_prompt,
        masterAbsoluteUrl,
        ctx.env,
        { model: "uni-1" },
      );
      launchedNew.push({ frame_index: frame.frame_index, luma_id: lumaEdit.id });
    } catch (e) {
      await handleDispatchFailure(ctx.env, id, frame, e as Error, "new_dispatch", noteSoftError);
    }
  }
  if (launchedNew.length > 0) {
    const dispatchedAtMs = Date.now();
    await ctx.env.DB.batch(
      launchedNew.map((l) =>
        ctx.env.DB
          .prepare(
            "UPDATE reel_frames SET status='in_flight', luma_generation_id=?, attempts=attempts+1, cost_usd=cost_usd+?, dispatched_at_ms=COALESCE(dispatched_at_ms, ?) WHERE piece_id=? AND frame_index=?",
          )
          .bind(l.luma_id, COST_PER_LUMA_UNI1, dispatchedAtMs, id, l.frame_index),
      ),
    );
  }

  // 5. Completion check.
  frames = await loadFrames(ctx.env, id);
  const userFramesFinal = frames.filter((f) => f.frame_index >= 1);
  const allAccepted = userFramesFinal.every((f) => f.status === "accepted");
  const anyFailed = userFramesFinal.some((f) => f.status === "failed");

  if (allAccepted) {
    await ctx.env.DB
      .prepare("UPDATE reel_pieces SET status='completed', completed_at=datetime('now') WHERE id=?")
      .bind(id)
      .run();
    piece = (await loadPiece(ctx.env, id)) ?? piece;
  } else if (anyFailed && userFramesFinal.every((f) => f.status === "accepted" || f.status === "failed")) {
    // Pipeline terminated but with at least one failure. Still mark
    // completed (partial); reader view will show failed slots gracefully.
    await ctx.env.DB
      .prepare("UPDATE reel_pieces SET status='completed', completed_at=datetime('now') WHERE id=?")
      .bind(id)
      .run();
    piece = (await loadPiece(ctx.env, id)) ?? piece;
  }

  await flushSoftErrors();
  return jsonResponse(snapshot(piece, frames));
};

void nowIso; // reserved for future timing fields
