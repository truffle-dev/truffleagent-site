// GET /api/cut/status/<id>
// The Cut state machine driver. Each poll advances the piece by AT MOST one
// bounded step, then returns a full snapshot. Idempotent: concurrent polls
// race on CAS updates; losers just snapshot. Crashed steps are reclaimed via
// dispatched_at_ms staleness windows (piece-level for plan/stitch/judge,
// shot-level for the per-shot sub-machine).
//
// Piece state machine (cut_pieces.status):
//   queued    -> planning   : bridge /cut/plan writes composition v1 + shot rows
//   planning  -> shooting   : (same step; planning is the in-flight marker)
//   shooting               : sequential per-shot sub-machine (below); when every
//                            shot in the current version is accepted -> stitching
//   stitching              : one async bridge job = take-stitch assemble +
//                            take-eval --skip-models on the final + seam eval;
//                            artifacts -> R2, doc.assembly updated -> judging
//   judging                : bridge /cut/judge-final (7 axes incl. continuity).
//                            accept -> completed. reject -> ONE bounded repair
//                            round (regen the named shot, re-stitch, re-judge);
//                            second reject completes with the honest score.
//   revising               : owned by POST /api/cut/revise; driver only snapshots.
//
// Shot sub-machine (cut_shots.status), strictly in shot_order because chain
// conditioning needs shot N-1's last frame:
//   composing  : attempt 1 composes deterministically (planner prompt + style
//                block); retakes go through bridge /cut/compose-shot with prior
//                evidence. Content-addressed cache checked BEFORE Luma submit.
//   generating : poll Luma; completed -> ingesting
//   ingesting  : video -> R2, bridge /cut/eval dispatch -> evaluating
//   evaluating : poll bridge; artifacts -> R2; gates fail -> retake (no judge)
//   judging    : bridge /cut/judge-shot -> accepted | retake (bounded)
//
// WAIT is code, DECIDE is the agent: this file never makes a quality call.

import {
  type CutEnv,
  type LumaVideoGeneration,
  type JudgeVerdict,
  type CompositionDoc,
  type CompositionShot,
  MAX_SHOT_ATTEMPTS,
  COST_CEILING_USD,
  PIECE_ID_RE,
  SHOT_ID_RE,
  shotVideoKey,
  shotSheetKey,
  shotFrameKey,
  finalVideoKey,
  finalSheetKey,
  seamSheetKey,
  costForShot,
  shotContentHash,
  jsonResponse,
  errorResponse,
  lumaSubmitVideo,
  lumaGetGeneration,
  lumaVideoUrl,
  bridgePost,
  bridgeGet,
  bridgeGetBytes,
  shotVerdictScore,
  shotVerdictAccepts,
  cutVerdictScore,
  cutVerdictAccepts,
  logEvent,
  SHOT_SECONDS,
} from "../../../_cut-shared.ts";

const STALE_STEP_MS = 4 * 60_000;    // reclaim a crashed compose/ingest/plan step
const STALE_JUDGE_MS = 6 * 60_000;   // judge calls run ~25-40s; 6 min is generous
const STALE_STITCH_MS = 8 * 60_000;  // assemble+eval+seams on 6 shots can take minutes
const MAX_STAGE_ERRORS = 4;          // same-stage soft errors before giving up
const MAX_EVAL_RETRIES = 2;          // eval re-dispatches after bridge restart/loss
const MAX_STITCH_RETRIES = 2;

type PieceRow = {
  id: string;
  slug: string;
  prompt_raw: string;
  title: string | null;
  aspect_ratio: string;
  resolution: string;
  target_seconds: number;
  status: string;
  current_version: number;
  accepted_version: number | null;
  revision_round: number;
  repair_used: number;
  final_key: string | null;
  final_sheet_key: string | null;
  seam_sheet_key: string | null;
  final_score: number | null;
  judge_json: string | null;
  state_json: string | null;
  visitor_hash: string;
  visible: number;
  error_log: string | null;
  cost_usd: number;
  dispatched_at_ms: number | null;
  created_at: string;
  completed_at: string | null;
};

type ShotRow = {
  piece_id: string;
  version: number;
  shot_id: string;
  attempt: number;
  shot_order: number;
  prompt: string | null;
  conditioning_json: string | null;
  content_hash: string | null;
  cached_from: string | null;
  luma_generation_id: string | null;
  status: string;
  video_key: string | null;
  sheet_key: string | null;
  frame_keys_json: string | null;
  last_frame_url: string | null;
  eval_json: string | null;
  judge_json: string | null;
  score: number | null;
  decision: string | null;
  failure_reason: string | null;
  cost_usd: number;
  gen_latency_ms: number | null;
  dispatched_at_ms: number | null;
  created_at: string;
  completed_at: string | null;
};

type PieceState = {
  stitch?: { job_id: string; retries: number };
  repair?: { shot: string; advice: string };
  note?: string;
};

type Ctx = Parameters<PagesFunction<CutEnv>>[0];

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// Ray3.2 preserves the 16:9 pixel-area budget across aspect ratios ("720p"
// at 1:1 renders 960x960). Compute expected height for the actual aspect.
function expectedHeightFor(r: string, aspectRatio: string): number {
  const [tierW, tierH] =
    r === "1080p" ? [1920, 1080] : r === "720p" ? [1280, 720] : [960, 540];
  const m = /^(\d+):(\d+)$/.exec(aspectRatio || "");
  if (!m) return tierH;
  const aw = Number(m[1]);
  const ah = Number(m[2]);
  if (!aw || !ah) return tierH;
  return Math.round(Math.sqrt((tierW * tierH * ah) / aw));
}

// ---------- composition doc ----------

async function getDoc(env: CutEnv, pieceId: string, version: number): Promise<CompositionDoc | null> {
  const row = await env.DB.prepare(
    `SELECT doc FROM cut_compositions WHERE piece_id = ?1 AND version = ?2`,
  )
    .bind(pieceId, version)
    .first<{ doc: string }>();
  return row ? parseJson<CompositionDoc>(row.doc) : null;
}

async function saveDoc(env: CutEnv, pieceId: string, version: number, doc: CompositionDoc): Promise<void> {
  await env.DB.prepare(
    `UPDATE cut_compositions SET doc = ?1 WHERE piece_id = ?2 AND version = ?3`,
  )
    .bind(JSON.stringify(doc), pieceId, version)
    .run();
}

async function setState(env: CutEnv, pieceId: string, state: PieceState): Promise<void> {
  await env.DB.prepare(`UPDATE cut_pieces SET state_json = ?1 WHERE id = ?2`)
    .bind(JSON.stringify(state), pieceId)
    .run();
}

// ---------- soft error accounting ----------

async function recordSoftError(
  ctx: Ctx,
  piece: PieceRow,
  stage: string,
  message: string,
): Promise<number> {
  const marker = `[v${piece.current_version}:${stage}]`;
  const line = `${marker} ${new Date().toISOString()} ${message.slice(0, 300)}`;
  const log = piece.error_log ? `${piece.error_log}\n${line}` : line;
  const trimmed = log.split("\n").slice(-40).join("\n");
  await ctx.env.DB.prepare(`UPDATE cut_pieces SET error_log = ?1 WHERE id = ?2`)
    .bind(trimmed, piece.id)
    .run();
  piece.error_log = trimmed;
  return trimmed.split("\n").filter((l) => l.startsWith(marker)).length;
}

// ---------- piece failure ----------

async function failPiece(ctx: Ctx, piece: PieceRow, reason: string): Promise<void> {
  await ctx.env.DB.prepare(
    `UPDATE cut_pieces SET status = 'failed', completed_at = datetime('now'),
            dispatched_at_ms = NULL
     WHERE id = ?1`,
  )
    .bind(piece.id)
    .run();
  await logEvent(ctx.env, piece.id, piece.current_version, null, "stage_fail", "piece", {
    reason: reason.slice(0, 300),
  });
}

// ---------- shot attempt failure -> retake or best-of ----------

async function failShotAttempt(
  ctx: Ctx,
  piece: PieceRow,
  shot: ShotRow,
  reason: string,
): Promise<void> {
  const env = ctx.env;
  const hasRetakes = shot.attempt < MAX_SHOT_ATTEMPTS;
  const decision = hasRetakes ? "retake" : "abort";
  const status = hasRetakes ? "retake" : "failed";

  await env.DB.prepare(
    `UPDATE cut_shots
       SET status = ?1, decision = ?2, failure_reason = ?3, completed_at = datetime('now'),
           dispatched_at_ms = NULL
     WHERE piece_id = ?4 AND version = ?5 AND shot_id = ?6 AND attempt = ?7`,
  )
    .bind(status, decision, reason.slice(0, 500), piece.id, shot.version, shot.shot_id, shot.attempt)
    .run();

  if (hasRetakes) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO cut_shots (piece_id, version, shot_id, attempt, shot_order, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'composing')`,
    )
      .bind(piece.id, shot.version, shot.shot_id, shot.attempt + 1, shot.shot_order)
      .run();
    await logEvent(env, piece.id, shot.version, shot.shot_id, "decision", "retake", {
      attempt: shot.attempt,
      reason: reason.slice(0, 300),
    });
    return;
  }

  // Attempts exhausted: accept the best previously-judged attempt with video
  // so the piece keeps moving; fail the piece only when nothing is usable.
  const rows = await env.DB.prepare(
    `SELECT * FROM cut_shots
      WHERE piece_id = ?1 AND version = ?2 AND shot_id = ?3
        AND judge_json IS NOT NULL AND video_key IS NOT NULL`,
  )
    .bind(piece.id, shot.version, shot.shot_id)
    .all<ShotRow>();

  let best: ShotRow | null = null;
  let bestScore = -1;
  for (const r of rows.results ?? []) {
    const v = parseJson<JudgeVerdict>(r.judge_json);
    if (!v) continue;
    const s = shotVerdictScore(v);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }

  if (best) {
    const doc = await getDoc(env, piece.id, shot.version);
    if (doc) await acceptShot(ctx, piece, doc, best, bestScore, "best_of_exhausted");
    return;
  }

  await failPiece(ctx, piece, `shot ${shot.shot_id}: ${reason}`);
}

// ---------- accept a shot: row + composition doc artifact ----------

async function acceptShot(
  ctx: Ctx,
  piece: PieceRow,
  doc: CompositionDoc,
  shot: ShotRow,
  score: number,
  note: string,
): Promise<void> {
  const env = ctx.env;
  await env.DB.prepare(
    `UPDATE cut_shots
       SET status = 'accepted', decision = 'accept', score = ?1,
           completed_at = datetime('now'), dispatched_at_ms = NULL
     WHERE piece_id = ?2 AND version = ?3 AND shot_id = ?4 AND attempt = ?5`,
  )
    .bind(score, piece.id, shot.version, shot.shot_id, shot.attempt)
    .run();

  // The composition doc is the source of truth: record the artifact.
  const docShot = doc.shots.find((s) => s.id === shot.shot_id);
  if (docShot) {
    docShot.content_hash = shot.content_hash ?? docShot.content_hash;
    docShot.artifact = {
      video_key: shot.video_key!,
      sheet_key: shot.sheet_key ?? "",
      last_frame_url: shot.last_frame_url ?? "",
      attempt: shot.attempt,
    };
    await saveDoc(env, piece.id, shot.version, doc);
  }

  await logEvent(env, piece.id, shot.version, shot.shot_id, "decision", "accept", {
    attempt: shot.attempt,
    score,
    note,
  });
}

// ---------- step: plan (queued/planning -> shooting) ----------

type PlanResponse = {
  plan: {
    title: string;
    style_block: string;
    shots: { id: string; prompt: string }[];
    transitions: { after: string; type: string; duration: number }[];
  };
  cost_usd: number;
};

async function doPlan(ctx: Ctx, piece: PieceRow): Promise<void> {
  const env = ctx.env;
  const shotCount = Math.round(piece.target_seconds / SHOT_SECONDS);

  const resp = await bridgePost<PlanResponse>(env, "/cut/plan", {
    piece_id: piece.id,
    raw: piece.prompt_raw,
    target_seconds: piece.target_seconds,
    shot_count: shotCount,
    aspect_ratio: piece.aspect_ratio,
    resolution: piece.resolution,
  });

  const plan = resp.plan;
  if (!Array.isArray(plan?.shots) || plan.shots.length < 2) {
    throw new Error("planner returned fewer than 2 shots");
  }

  // Normalize: ids s1..sN in order, transitions exactly N-1, valid types.
  const shots: CompositionShot[] = plan.shots.slice(0, 6).map((s, i) => ({
    id: `s${i + 1}`,
    order: i,
    prompt: String(s.prompt ?? "").slice(0, 1200),
    duration_s: SHOT_SECONDS,
    conditioning: i === 0 ? { mode: "none" as const } : { mode: "chain" as const, source_shot: `s${i}` },
  }));
  const transitions = shots.slice(0, -1).map((s, i) => {
    const t = plan.transitions?.[i];
    const type = t?.type === "xfade" ? "xfade" as const : "cut" as const;
    const duration = type === "xfade" ? Math.min(1, Math.max(0.3, Number(t?.duration) || 0.5)) : 0;
    return { after: s.id, type, duration };
  });

  const doc: CompositionDoc = {
    version: 1,
    title: String(plan.title ?? "").slice(0, 120) || undefined,
    aspect_ratio: piece.aspect_ratio as CompositionDoc["aspect_ratio"],
    resolution: piece.resolution as CompositionDoc["resolution"],
    style_block: String(plan.style_block ?? "").slice(0, 600),
    shots,
    transitions,
  };

  const stmts = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO cut_compositions (piece_id, version, doc) VALUES (?1, 1, ?2)`,
    ).bind(piece.id, JSON.stringify(doc)),
    ...shots.map((s) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO cut_shots (piece_id, version, shot_id, attempt, shot_order, status)
         VALUES (?1, 1, ?2, 1, ?3, 'composing')`,
      ).bind(piece.id, s.id, s.order),
    ),
    env.DB.prepare(
      `UPDATE cut_pieces
         SET status = 'shooting', title = ?1, current_version = 1,
             cost_usd = cost_usd + ?2, dispatched_at_ms = NULL
       WHERE id = ?3`,
    ).bind(doc.title ?? null, resp.cost_usd ?? 0, piece.id),
  ];
  await env.DB.batch(stmts);
  await logEvent(env, piece.id, 1, null, "stage_done", "plan", {
    title: doc.title ?? null,
    shots: shots.map((s) => ({ id: s.id, prompt: s.prompt.slice(0, 140) })),
    transitions,
    style_block: doc.style_block.slice(0, 200),
  });
}

// ---------- step: compose a shot + submit (with content-addressed cache) ----------

async function doComposeShot(
  ctx: Ctx,
  piece: PieceRow,
  doc: CompositionDoc,
  shot: ShotRow,
): Promise<void> {
  const env = ctx.env;
  const docShot = doc.shots.find((s) => s.id === shot.shot_id);
  if (!docShot) throw new Error(`shot ${shot.shot_id} missing from composition`);

  const state = parseJson<PieceState>(piece.state_json) ?? {};

  // Attempt 1 composes deterministically from the planner's shot prompt.
  // Retakes (and the repair round) go through the bridge with prior evidence.
  let prompt = docShot.prompt;
  let composeCost = 0;
  const repairAdvice = state.repair?.shot === shot.shot_id ? state.repair.advice : undefined;
  if (shot.attempt > 1 || repairAdvice) {
    let prior: Record<string, unknown> | undefined;
    if (shot.attempt > 1) {
      const prev = await env.DB.prepare(
        `SELECT prompt, eval_json, judge_json, failure_reason FROM cut_shots
          WHERE piece_id = ?1 AND version = ?2 AND shot_id = ?3 AND attempt = ?4`,
      )
        .bind(piece.id, shot.version, shot.shot_id, shot.attempt - 1)
        .first<Pick<ShotRow, "prompt" | "eval_json" | "judge_json" | "failure_reason">>();
      if (prev) {
        const evalRes = parseJson<Record<string, unknown>>(prev.eval_json);
        prior = {
          prompt: prev.prompt ?? undefined,
          gates: evalRes?.gates ?? undefined,
          judge: parseJson<unknown>(prev.judge_json) ?? undefined,
          failure: prev.failure_reason ?? undefined,
        };
      }
    }
    const resp = await bridgePost<{ composed: { prompt: string }; cost_usd: number }>(
      env,
      "/cut/compose-shot",
      {
        piece_id: piece.id,
        version: shot.version,
        shot_id: shot.shot_id,
        attempt: shot.attempt,
        raw: piece.prompt_raw,
        shot_prompt: docShot.prompt,
        style_block: doc.style_block,
        prior,
        repair_advice: repairAdvice,
      },
    );
    prompt = resp.composed.prompt;
    composeCost = resp.cost_usd ?? 0;
  }

  const finalPrompt = doc.style_block ? `${prompt}\n\nStyle: ${doc.style_block}` : prompt;

  // Conditioning: chain mode pins to the SOURCE shot's accepted artifact.
  // Fingerprint uses the source video_key so regenerating shot N-1
  // invalidates shot N's cache entry.
  let conditioningFingerprint = "none";
  let startFrameUrl: string | undefined;
  const cond = docShot.conditioning;
  if (cond.mode === "chain") {
    const src = doc.shots.find((s) => s.id === cond.source_shot);
    if (!src?.artifact?.video_key || !src.artifact.last_frame_url) {
      throw new Error(`chain source ${cond.source_shot} has no accepted artifact`);
    }
    conditioningFingerprint = src.artifact.video_key;
    const origin = new URL(ctx.request.url).origin;
    startFrameUrl = `${origin}${src.artifact.last_frame_url}`;
  }

  const contentHash = await shotContentHash(doc, { ...docShot, prompt: finalPrompt }, conditioningFingerprint);
  const conditioningJson = JSON.stringify(
    cond.mode === "chain" ? { ...cond, image_url: startFrameUrl } : cond,
  );

  // Cache: a prior accepted render of the exact same content in this piece
  // (any version). Revisions that leave a shot untouched land here for free.
  const cached = await env.DB.prepare(
    `SELECT version, attempt, video_key, sheet_key, frame_keys_json, last_frame_url,
            judge_json, score
       FROM cut_shots
      WHERE piece_id = ?1 AND content_hash = ?2 AND status = 'accepted'
        AND video_key IS NOT NULL
        AND NOT (version = ?3 AND shot_id = ?4 AND attempt = ?5)
      ORDER BY version DESC, attempt DESC LIMIT 1`,
  )
    .bind(piece.id, contentHash, shot.version, shot.shot_id, shot.attempt)
    .first<Pick<ShotRow, "version" | "attempt" | "video_key" | "sheet_key" | "frame_keys_json" | "last_frame_url" | "judge_json" | "score">>();

  if (cached) {
    const cachedFrom = `v${cached.version}/a${cached.attempt}`;
    await env.DB.prepare(
      `UPDATE cut_shots
         SET status = 'accepted', decision = 'accept', prompt = ?1, conditioning_json = ?2,
             content_hash = ?3, cached_from = ?4, video_key = ?5, sheet_key = ?6,
             frame_keys_json = ?7, last_frame_url = ?8, judge_json = ?9, score = ?10,
             completed_at = datetime('now'), dispatched_at_ms = NULL
       WHERE piece_id = ?11 AND version = ?12 AND shot_id = ?13 AND attempt = ?14`,
    )
      .bind(
        finalPrompt,
        conditioningJson,
        contentHash,
        cachedFrom,
        cached.video_key,
        cached.sheet_key,
        cached.frame_keys_json,
        cached.last_frame_url,
        cached.judge_json,
        cached.score,
        piece.id,
        shot.version,
        shot.shot_id,
        shot.attempt,
      )
      .run();

    const docShotRef = doc.shots.find((s) => s.id === shot.shot_id)!;
    docShotRef.content_hash = contentHash;
    docShotRef.artifact = {
      video_key: cached.video_key!,
      sheet_key: cached.sheet_key ?? "",
      last_frame_url: cached.last_frame_url ?? "",
      attempt: shot.attempt,
      from_version: cached.version,
    };
    await saveDoc(env, piece.id, shot.version, doc);
    await logEvent(env, piece.id, shot.version, shot.shot_id, "stage_done", "cache_hit", {
      cached_from: cachedFrom,
      content_hash: contentHash.slice(0, 12),
    });
    return;
  }

  // Hard cost ceiling before spending Luma dollars.
  const shotCost = costForShot(piece.resolution);
  const fresh = await env.DB.prepare(`SELECT cost_usd FROM cut_pieces WHERE id = ?1`)
    .bind(piece.id)
    .first<{ cost_usd: number }>();
  if ((fresh?.cost_usd ?? 0) + shotCost > COST_CEILING_USD) {
    await failPiece(ctx, piece, `cost ceiling $${COST_CEILING_USD} reached`);
    return;
  }

  const gen = await lumaSubmitVideo(
    {
      prompt: finalPrompt,
      resolution: piece.resolution as never,
      aspect_ratio: piece.aspect_ratio as never,
      start_frame_url: startFrameUrl,
    },
    env,
  );

  const stepCost = composeCost + shotCost;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE cut_shots
         SET prompt = ?1, conditioning_json = ?2, content_hash = ?3,
             luma_generation_id = ?4, status = 'generating', dispatched_at_ms = ?5,
             cost_usd = cost_usd + ?6
       WHERE piece_id = ?7 AND version = ?8 AND shot_id = ?9 AND attempt = ?10`,
    ).bind(
      finalPrompt,
      conditioningJson,
      contentHash,
      gen.id,
      Date.now(),
      stepCost,
      piece.id,
      shot.version,
      shot.shot_id,
      shot.attempt,
    ),
    env.DB.prepare(`UPDATE cut_pieces SET cost_usd = cost_usd + ?1 WHERE id = ?2`).bind(
      stepCost,
      piece.id,
    ),
  ]);
  await logEvent(env, piece.id, shot.version, shot.shot_id, "stage_done", "compose", {
    attempt: shot.attempt,
    prompt: finalPrompt.slice(0, 240),
    conditioning: cond.mode,
    luma_generation_id: gen.id,
    cost_usd: stepCost,
  });
}

// ---------- step: shot ingest (luma done -> R2 -> start eval) ----------

async function doShotIngest(ctx: Ctx, piece: PieceRow, shot: ShotRow): Promise<void> {
  const env = ctx.env;
  const vKey = shotVideoKey(piece.id, shot.version, shot.shot_id, shot.attempt);

  let haveVideo = (await env.CUT_BUCKET.head(vKey)) !== null;
  if (!haveVideo) {
    // Presigned URLs expire in 1h; re-poll the generation for a fresh one.
    const gen = await lumaGetGeneration(shot.luma_generation_id!, env);
    const url = lumaVideoUrl(gen);
    if (!url) throw new Error("completed generation has no video url");
    const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!r.ok) throw new Error(`video download ${r.status}`);
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error("empty video download");
    await env.CUT_BUCKET.put(vKey, bytes, { httpMetadata: { contentType: "video/mp4" } });
    haveVideo = true;
  }

  const origin = new URL(ctx.request.url).origin;
  const evalResp = await bridgePost<{ eval_id: string }>(env, "/cut/eval", {
    piece_id: piece.id,
    version: shot.version,
    shot_id: shot.shot_id,
    attempt: shot.attempt,
    video_url: `${origin}/v-cut/${vKey}`,
    prompt: shot.prompt ?? piece.prompt_raw,
    expected_duration_s: SHOT_SECONDS,
    expected_height: expectedHeightFor(piece.resolution, piece.aspect_ratio),
  });

  const priorEval = parseJson<Record<string, unknown>>(shot.eval_json) ?? {};
  const evalState = {
    eval_id: evalResp.eval_id,
    eval_retries: (priorEval.eval_retries as number) ?? 0,
  };

  await env.DB.prepare(
    `UPDATE cut_shots
       SET status = 'evaluating', video_key = ?1, eval_json = ?2, dispatched_at_ms = ?3
     WHERE piece_id = ?4 AND version = ?5 AND shot_id = ?6 AND attempt = ?7`,
  )
    .bind(vKey, JSON.stringify(evalState), Date.now(), piece.id, shot.version, shot.shot_id, shot.attempt)
    .run();
  await logEvent(env, piece.id, shot.version, shot.shot_id, "stage_done", "ingest", {
    video_key: vKey,
    eval_id: evalResp.eval_id,
  });
}

// ---------- step: shot eval results -> artifacts -> gate decision ----------

type EngineResults = {
  gates?: Array<{ name: string; passed: boolean; value: unknown }>;
  gates_passed?: boolean;
  sampled_frames?: Array<{ index: number; time_s: number; path: string }>;
  metrics?: Record<string, unknown>;
  contact_sheet?: string;
  probe?: Record<string, unknown>;
  elapsed_s?: number;
};

async function doShotEvalDone(
  ctx: Ctx,
  piece: PieceRow,
  shot: ShotRow,
  evalId: string,
  results: EngineResults,
): Promise<void> {
  const env = ctx.env;
  const sKey = shotSheetKey(piece.id, shot.version, shot.shot_id, shot.attempt);
  try {
    const sheet = await bridgeGetBytes(env, `/cut/eval-artifact/${evalId}/sheet.jpg`);
    await env.CUT_BUCKET.put(sKey, sheet.bytes, { httpMetadata: { contentType: "image/jpeg" } });
  } catch {
    // sheet may be absent on gate-fail runs; non-fatal
  }

  const frameKeys: string[] = [];
  const frames = results.sampled_frames ?? [];
  for (let i = 0; i < frames.length; i++) {
    const bare = frames[i].path.split("/").pop()!;
    const fKey = shotFrameKey(piece.id, shot.version, shot.shot_id, shot.attempt, i);
    try {
      const img = await bridgeGetBytes(env, `/cut/eval-artifact/${evalId}/${bare}`);
      await env.CUT_BUCKET.put(fKey, img.bytes, { httpMetadata: { contentType: "image/jpeg" } });
      frameKeys.push(fKey);
    } catch {
      // skip a missing frame rather than failing the attempt
    }
  }

  // sample_frames always includes the LAST frame: it conditions the next
  // shot (chain mode). Stored as a public path; absolutized at submit time.
  const lastFrameUrl = frameKeys.length ? `/i-cut/${frameKeys[frameKeys.length - 1]}` : null;

  const priorEval = parseJson<Record<string, unknown>>(shot.eval_json) ?? {};
  const fullEval = { eval_id: evalId, eval_retries: priorEval.eval_retries ?? 0, ...results };

  if (results.gates_passed === false) {
    await env.DB.prepare(
      `UPDATE cut_shots
         SET eval_json = ?1, sheet_key = ?2, frame_keys_json = ?3, last_frame_url = ?4
       WHERE piece_id = ?5 AND version = ?6 AND shot_id = ?7 AND attempt = ?8`,
    )
      .bind(JSON.stringify(fullEval), sKey, JSON.stringify(frameKeys), lastFrameUrl, piece.id, shot.version, shot.shot_id, shot.attempt)
      .run();
    const failedGates = (results.gates ?? []).filter((g) => !g.passed).map((g) => g.name);
    await logEvent(env, piece.id, shot.version, shot.shot_id, "stage_fail", "gates", { failed: failedGates });
    await failShotAttempt(ctx, piece, shot, `gates failed: ${failedGates.join(", ")}`);
    return;
  }

  // CAS evaluating -> judging on the shot row; loser polls just snapshot.
  const cas = await env.DB.prepare(
    `UPDATE cut_shots SET status = 'judging', eval_json = ?1, sheet_key = ?2,
            frame_keys_json = ?3, last_frame_url = ?4, dispatched_at_ms = NULL
     WHERE piece_id = ?5 AND version = ?6 AND shot_id = ?7 AND attempt = ?8
       AND status = 'evaluating'`,
  )
    .bind(JSON.stringify(fullEval), sKey, JSON.stringify(frameKeys), lastFrameUrl, piece.id, shot.version, shot.shot_id, shot.attempt)
    .run();
  if ((cas.meta.changes ?? 0) === 0) return;
  await logEvent(env, piece.id, shot.version, shot.shot_id, "stage_done", "eval", {
    gates_passed: true,
    frames: frameKeys.length,
    elapsed_s: results.elapsed_s ?? null,
  });
}

// Re-dispatch the eval after the bridge lost the job (restart wipes its
// in-memory registry). Bounded by MAX_EVAL_RETRIES.
async function redispatchShotEval(ctx: Ctx, piece: PieceRow, shot: ShotRow): Promise<void> {
  const env = ctx.env;
  const prior = parseJson<Record<string, unknown>>(shot.eval_json) ?? {};
  const retries = ((prior.eval_retries as number) ?? 0) + 1;
  if (retries > MAX_EVAL_RETRIES) {
    await failShotAttempt(ctx, piece, shot, "eval lost repeatedly (bridge restarts)");
    return;
  }
  const cas = await env.DB.prepare(
    `UPDATE cut_shots SET dispatched_at_ms = ?1
     WHERE piece_id = ?2 AND version = ?3 AND shot_id = ?4 AND attempt = ?5
       AND dispatched_at_ms = ?6`,
  )
    .bind(Date.now(), piece.id, shot.version, shot.shot_id, shot.attempt, shot.dispatched_at_ms)
    .run();
  if ((cas.meta.changes ?? 0) === 0) return;

  const origin = new URL(ctx.request.url).origin;
  const evalResp = await bridgePost<{ eval_id: string }>(env, "/cut/eval", {
    piece_id: piece.id,
    version: shot.version,
    shot_id: shot.shot_id,
    attempt: shot.attempt,
    video_url: `${origin}/v-cut/${shot.video_key}`,
    prompt: shot.prompt ?? piece.prompt_raw,
    expected_duration_s: SHOT_SECONDS,
    expected_height: expectedHeightFor(piece.resolution, piece.aspect_ratio),
  });
  await env.DB.prepare(
    `UPDATE cut_shots SET eval_json = ?1
     WHERE piece_id = ?2 AND version = ?3 AND shot_id = ?4 AND attempt = ?5`,
  )
    .bind(
      JSON.stringify({ eval_id: evalResp.eval_id, eval_retries: retries }),
      piece.id,
      shot.version,
      shot.shot_id,
      shot.attempt,
    )
    .run();
  await logEvent(env, piece.id, shot.version, shot.shot_id, "stage_start", "eval_retry", {
    retry: retries,
    eval_id: evalResp.eval_id,
  });
}

// ---------- step: shot judge ----------

async function doShotJudge(ctx: Ctx, piece: PieceRow, doc: CompositionDoc, shot: ShotRow): Promise<void> {
  const env = ctx.env;
  const evalState = parseJson<{ eval_id: string }>(shot.eval_json);
  if (!evalState?.eval_id || !shot.prompt) {
    await failShotAttempt(ctx, piece, shot, "judge step missing eval or prompt state");
    return;
  }

  let resp: { verdict: JudgeVerdict; cost_usd: number };
  try {
    resp = await bridgePost<{ verdict: JudgeVerdict; cost_usd: number }>(env, "/cut/judge-shot", {
      piece_id: piece.id,
      version: shot.version,
      shot_id: shot.shot_id,
      attempt: shot.attempt,
      eval_id: evalState.eval_id,
      prompt: shot.prompt,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("eval_not_ready") || msg.includes("409")) {
      // Bridge restarted and lost the eval dir; fall back to re-evaluating.
      await env.DB.prepare(
        `UPDATE cut_shots SET status = 'evaluating', dispatched_at_ms = 0
         WHERE piece_id = ?1 AND version = ?2 AND shot_id = ?3 AND attempt = ?4
           AND status = 'judging'`,
      )
        .bind(piece.id, shot.version, shot.shot_id, shot.attempt)
        .run();
      return;
    }
    throw e;
  }

  const verdict = resp.verdict;
  const judgeCost = resp.cost_usd ?? 0;
  const score = shotVerdictScore(verdict);
  const accepted = shotVerdictAccepts(verdict);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE cut_shots SET judge_json = ?1, cost_usd = cost_usd + ?2
       WHERE piece_id = ?3 AND version = ?4 AND shot_id = ?5 AND attempt = ?6`,
    ).bind(JSON.stringify(verdict), judgeCost, piece.id, shot.version, shot.shot_id, shot.attempt),
    env.DB.prepare(`UPDATE cut_pieces SET cost_usd = cost_usd + ?1 WHERE id = ?2`).bind(judgeCost, piece.id),
  ]);
  await logEvent(env, piece.id, shot.version, shot.shot_id, "decision", "judge", {
    attempt: shot.attempt,
    score,
    accepted,
    axes: Object.fromEntries(Object.entries(verdict.axes ?? {}).map(([k, v]) => [k, v.level])),
  });

  if (accepted) {
    await acceptShot(ctx, piece, doc, shot, score, "judge_accept");
    return;
  }
  const reason = verdict.retake_advice?.trim() || `judge rejected (score ${score}/24)`;
  await failShotAttempt(ctx, piece, shot, reason);
}

// ---------- step: stitch (dispatch + poll one async bridge job) ----------

type StitchResults = {
  final?: string;            // artifact name of the assembled mp4
  duration_s?: number;
  sheet?: string;            // final contact sheet artifact name
  seam_sheet?: string;
  seams?: { after: string; dino_cosine: number }[];
  gates?: Array<{ name: string; passed: boolean; value: unknown }>;
  gates_passed?: boolean;
};

async function dispatchStitch(ctx: Ctx, piece: PieceRow, doc: CompositionDoc, retries: number): Promise<void> {
  const env = ctx.env;
  const origin = new URL(ctx.request.url).origin;
  const shots = doc.shots
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      if (!s.artifact?.video_key) throw new Error(`stitch: shot ${s.id} has no artifact`);
      return {
        id: s.id,
        video_url: `${origin}/v-cut/${s.artifact.video_key}`,
        duration_s: s.duration_s,
      };
    });

  const resp = await bridgePost<{ job_id: string }>(env, "/cut/stitch", {
    piece_id: piece.id,
    version: piece.current_version,
    shots,
    transitions: doc.transitions,
    prompt: piece.prompt_raw,
    expected_height: expectedHeightFor(piece.resolution, piece.aspect_ratio),
    expected_duration_s: assembledDuration(doc),
  });

  const state = parseJson<PieceState>(piece.state_json) ?? {};
  state.stitch = { job_id: resp.job_id, retries };
  await setState(env, piece.id, state);
  await logEvent(env, piece.id, piece.current_version, null, "stage_start", "stitch", {
    job_id: resp.job_id,
    shots: shots.length,
  });
}

function assembledDuration(doc: CompositionDoc): number {
  let d = 0;
  for (const s of doc.shots) d += s.duration_s;
  for (const t of doc.transitions) if (t.type === "xfade") d -= t.duration;
  return Math.round(d * 100) / 100;
}

async function doStitchDone(
  ctx: Ctx,
  piece: PieceRow,
  doc: CompositionDoc,
  jobId: string,
  results: StitchResults,
): Promise<void> {
  const env = ctx.env;
  const v = piece.current_version;

  if (results.gates_passed === false) {
    const failed = (results.gates ?? []).filter((g) => !g.passed).map((g) => g.name);
    await failPiece(ctx, piece, `final gates failed: ${failed.join(", ")}`);
    return;
  }

  const fKey = finalVideoKey(piece.id, v);
  const fsKey = finalSheetKey(piece.id, v);
  const smKey = seamSheetKey(piece.id, v);

  const finalBytes = await bridgeGetBytes(env, `/cut/stitch-artifact/${jobId}/${results.final ?? "final.mp4"}`, 120_000);
  await env.CUT_BUCKET.put(fKey, finalBytes.bytes, { httpMetadata: { contentType: "video/mp4" } });
  try {
    const sheet = await bridgeGetBytes(env, `/cut/stitch-artifact/${jobId}/${results.sheet ?? "sheet.jpg"}`);
    await env.CUT_BUCKET.put(fsKey, sheet.bytes, { httpMetadata: { contentType: "image/jpeg" } });
  } catch {
    // non-fatal
  }
  try {
    const seamSheet = await bridgeGetBytes(env, `/cut/stitch-artifact/${jobId}/${results.seam_sheet ?? "seam_sheet.jpg"}`);
    await env.CUT_BUCKET.put(smKey, seamSheet.bytes, { httpMetadata: { contentType: "image/jpeg" } });
  } catch {
    // non-fatal
  }

  doc.assembly = {
    final_key: fKey,
    duration_s: results.duration_s ?? assembledDuration(doc),
    seams: results.seams ?? [],
  };
  await saveDoc(env, piece.id, v, doc);

  // CAS stitching -> judging; record artifact keys, clear the step marker.
  const cas = await env.DB.prepare(
    `UPDATE cut_pieces
       SET status = 'judging', final_key = ?1, final_sheet_key = ?2, seam_sheet_key = ?3,
           dispatched_at_ms = NULL
     WHERE id = ?4 AND status = 'stitching'`,
  )
    .bind(fKey, fsKey, smKey, piece.id)
    .run();
  if ((cas.meta.changes ?? 0) === 0) return;
  await logEvent(env, piece.id, v, null, "stage_done", "stitch", {
    final_key: fKey,
    duration_s: doc.assembly.duration_s,
    seams: doc.assembly.seams,
  });
}

// ---------- step: final judge -> completed | one repair round ----------

async function doFinalJudge(ctx: Ctx, piece: PieceRow, doc: CompositionDoc): Promise<void> {
  const env = ctx.env;
  const v = piece.current_version;
  const state = parseJson<PieceState>(piece.state_json) ?? {};
  const jobId = state.stitch?.job_id;
  if (!jobId) {
    // Lost the stitch job reference; re-stitch (artifacts in R2 stay valid).
    await env.DB.prepare(
      `UPDATE cut_pieces SET status = 'stitching', dispatched_at_ms = NULL WHERE id = ?1 AND status = 'judging'`,
    )
      .bind(piece.id)
      .run();
    return;
  }

  let resp: { verdict: JudgeVerdict & { repair_shot?: string }; cost_usd: number };
  try {
    resp = await bridgePost<{ verdict: JudgeVerdict & { repair_shot?: string }; cost_usd: number }>(
      env,
      "/cut/judge-final",
      {
        piece_id: piece.id,
        version: v,
        job_id: jobId,
        prompt: piece.prompt_raw,
        title: doc.title ?? null,
        shots: doc.shots.map((s) => ({ id: s.id, prompt: s.prompt.slice(0, 200) })),
        transitions: doc.transitions,
        seams: doc.assembly?.seams ?? [],
        repair_available: piece.repair_used === 0,
      },
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("eval_not_ready") || msg.includes("409")) {
      // Bridge restarted and lost the stitch dir; re-stitch this version.
      const st = parseJson<PieceState>(piece.state_json) ?? {};
      delete st.stitch;
      await setState(env, piece.id, st);
      await env.DB.prepare(
        `UPDATE cut_pieces SET status = 'stitching', dispatched_at_ms = NULL WHERE id = ?1 AND status = 'judging'`,
      )
        .bind(piece.id)
        .run();
      return;
    }
    throw e;
  }

  const verdict = resp.verdict;
  const judgeCost = resp.cost_usd ?? 0;
  const score = cutVerdictScore(verdict);
  const accepted = cutVerdictAccepts(verdict);

  await logEvent(env, piece.id, v, null, "decision", "final_judge", {
    score,
    accepted,
    axes: Object.fromEntries(Object.entries(verdict.axes ?? {}).map(([k, vv]) => [k, vv.level])),
    repair_shot: verdict.repair_shot ?? null,
  });

  if (accepted) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE cut_pieces
           SET status = 'completed', accepted_version = ?1, final_score = ?2,
               judge_json = ?3, cost_usd = cost_usd + ?4, completed_at = datetime('now'),
               dispatched_at_ms = NULL
         WHERE id = ?5`,
      ).bind(v, score, JSON.stringify(verdict), judgeCost, piece.id),
    ]);
    return;
  }

  // One bounded repair round per version: regen the shot the judge named,
  // then re-stitch and re-judge. Spending another judge call is cheaper than
  // shipping a piece with a visibly broken shot.
  const repairShot = verdict.repair_shot && SHOT_ID_RE.test(verdict.repair_shot) ? verdict.repair_shot : null;
  const canRepair =
    piece.repair_used === 0 &&
    repairShot !== null &&
    doc.shots.some((s) => s.id === repairShot);

  if (canRepair) {
    const maxAttempt = await env.DB.prepare(
      `SELECT MAX(attempt) AS m FROM cut_shots WHERE piece_id = ?1 AND version = ?2 AND shot_id = ?3`,
    )
      .bind(piece.id, v, repairShot)
      .first<{ m: number }>();
    const nextAttempt = (maxAttempt?.m ?? 1) + 1;
    const order = doc.shots.find((s) => s.id === repairShot)!.order;
    const advice = verdict.retake_advice?.trim() || verdict.summary?.trim() || "improve this shot";
    const st = parseJson<PieceState>(piece.state_json) ?? {};
    st.repair = { shot: repairShot, advice };

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO cut_shots (piece_id, version, shot_id, attempt, shot_order, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'composing')`,
      ).bind(piece.id, v, repairShot, nextAttempt, order),
      env.DB.prepare(
        `UPDATE cut_pieces
           SET status = 'shooting', repair_used = 1, judge_json = ?1, state_json = ?2,
               cost_usd = cost_usd + ?3, dispatched_at_ms = NULL
         WHERE id = ?4 AND status = 'judging'`,
      ).bind(JSON.stringify(verdict), JSON.stringify(st), judgeCost, piece.id),
    ]);
    await logEvent(env, piece.id, v, repairShot, "decision", "repair", {
      advice: advice.slice(0, 300),
      attempt: nextAttempt,
    });
    return;
  }

  // No repair left: complete with the honest score. All shots individually
  // passed and dollars are spent; an honest sub-bar score beats a failure.
  await env.DB.prepare(
    `UPDATE cut_pieces
       SET status = 'completed', accepted_version = ?1, final_score = ?2,
           judge_json = ?3, cost_usd = cost_usd + ?4, completed_at = datetime('now'),
           dispatched_at_ms = NULL
     WHERE id = ?5`,
  )
    .bind(v, score, JSON.stringify(verdict), judgeCost, piece.id)
    .run();
  await logEvent(env, piece.id, v, null, "decision", "complete_below_bar", { score });
}

// ---------- snapshot ----------

async function snapshot(ctx: Ctx, pieceId: string, note?: string): Promise<Response> {
  const env = ctx.env;
  const piece = await env.DB.prepare(`SELECT * FROM cut_pieces WHERE id = ?1`)
    .bind(pieceId)
    .first<PieceRow>();
  if (!piece) return errorResponse(404, "not_found", "Unknown piece.");

  const doc = await getDoc(env, pieceId, piece.current_version);
  const shots = await env.DB.prepare(
    `SELECT * FROM cut_shots WHERE piece_id = ?1 AND version = ?2
     ORDER BY shot_order ASC, attempt ASC`,
  )
    .bind(pieceId, piece.current_version)
    .all<ShotRow>();

  const out = {
    ok: true,
    id: piece.id,
    slug: piece.slug,
    status: piece.status,
    title: piece.title,
    prompt_raw: piece.prompt_raw,
    aspect_ratio: piece.aspect_ratio,
    resolution: piece.resolution,
    target_seconds: piece.target_seconds,
    current_version: piece.current_version,
    accepted_version: piece.accepted_version,
    revision_round: piece.revision_round,
    repair_used: piece.repair_used === 1,
    final_score: piece.final_score,
    cost_usd: Math.round(piece.cost_usd * 1000) / 1000,
    created_at: piece.created_at,
    completed_at: piece.completed_at,
    final_url: piece.final_key ? `/v-cut/${piece.final_key}` : null,
    final_sheet_url: piece.final_sheet_key ? `/i-cut/${piece.final_sheet_key}` : null,
    seam_sheet_url: piece.seam_sheet_key ? `/i-cut/${piece.seam_sheet_key}` : null,
    judge: parseJson<unknown>(piece.judge_json),
    composition: doc,
    note: note ?? null,
    shots: (shots.results ?? []).map((s) => {
      const evalRes = parseJson<EngineResults & { eval_id?: string }>(s.eval_json);
      const frameKeys = parseJson<string[]>(s.frame_keys_json) ?? [];
      return {
        shot_id: s.shot_id,
        attempt: s.attempt,
        shot_order: s.shot_order,
        status: s.status,
        decision: s.decision,
        failure_reason: s.failure_reason,
        prompt: s.prompt,
        conditioning: parseJson<unknown>(s.conditioning_json),
        cached_from: s.cached_from,
        video_url: s.video_key ? `/v-cut/${s.video_key}` : null,
        sheet_url: s.sheet_key ? `/i-cut/${s.sheet_key}` : null,
        frame_urls: frameKeys.map((k) => `/i-cut/${k}`),
        last_frame_url: s.last_frame_url,
        eval: evalRes
          ? {
              gates: evalRes.gates ?? null,
              gates_passed: evalRes.gates_passed ?? null,
              metrics: evalRes.metrics ?? null,
              elapsed_s: evalRes.elapsed_s ?? null,
            }
          : null,
        judge: parseJson<unknown>(s.judge_json),
        score: s.score,
        cost_usd: Math.round(s.cost_usd * 1000) / 1000,
        gen_latency_ms: s.gen_latency_ms,
      };
    }),
  };
  return jsonResponse(out);
}

// ---------- driver ----------

export const onRequestGet: PagesFunction<CutEnv> = async (ctx) => {
  const id = String(ctx.params.id ?? "");
  if (!PIECE_ID_RE.test(id)) return errorResponse(400, "invalid_id", "Malformed piece id.");
  const env = ctx.env;

  const piece = await env.DB.prepare(`SELECT * FROM cut_pieces WHERE id = ?1`)
    .bind(id)
    .first<PieceRow>();
  if (!piece) return errorResponse(404, "not_found", "Unknown piece.");

  // Terminal or externally-owned states: no work, just snapshot.
  if (piece.status === "completed" || piece.status === "failed" || piece.status === "revising") {
    return snapshot(ctx as Ctx, id);
  }

  const now = Date.now();
  let stage = piece.status;
  // Shot context for soft-error attribution inside the shooting stage.
  let activeShotRef: ShotRow | null = null;

  try {
    switch (piece.status) {
      case "queued": {
        stage = "plan";
        const cas = await env.DB.prepare(
          `UPDATE cut_pieces SET status = 'planning', dispatched_at_ms = ?1
           WHERE id = ?2 AND status = 'queued'`,
        )
          .bind(now, id)
          .run();
        if ((cas.meta.changes ?? 0) === 0) break;
        await doPlan(ctx as Ctx, piece);
        break;
      }

      case "planning": {
        stage = "plan";
        if (piece.dispatched_at_ms && now - piece.dispatched_at_ms < STALE_STEP_MS) break;
        const cas = await env.DB.prepare(
          `UPDATE cut_pieces SET dispatched_at_ms = ?1
           WHERE id = ?2 AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?3)`,
        )
          .bind(now, id, piece.dispatched_at_ms)
          .run();
        if ((cas.meta.changes ?? 0) === 0) break;
        await doPlan(ctx as Ctx, piece);
        break;
      }

      case "shooting": {
        stage = "shoot";
        const doc = await getDoc(env, id, piece.current_version);
        if (!doc) {
          await failPiece(ctx as Ctx, piece, "shooting without a composition");
          break;
        }

        // Latest attempt per shot, walked in timeline order. The first
        // not-yet-accepted shot is the active one (sequential: chain
        // conditioning needs shot N-1's last frame).
        const rows = await env.DB.prepare(
          `SELECT * FROM cut_shots WHERE piece_id = ?1 AND version = ?2
           ORDER BY shot_order ASC, attempt ASC`,
        )
          .bind(id, piece.current_version)
          .all<ShotRow>();
        const latest = new Map<string, ShotRow>();
        for (const r of rows.results ?? []) latest.set(r.shot_id, r);

        let active: ShotRow | null = null;
        for (const s of doc.shots.slice().sort((a, b) => a.order - b.order)) {
          const row = latest.get(s.id);
          if (!row) {
            await failPiece(ctx as Ctx, piece, `shot row missing for ${s.id}`);
            return snapshot(ctx as Ctx, id);
          }
          if (row.status !== "accepted") {
            active = row;
            break;
          }
        }

        if (!active) {
          // Every shot accepted: clear any repair note, move to stitching.
          const st = parseJson<PieceState>(piece.state_json) ?? {};
          delete st.repair;
          delete st.stitch;
          await env.DB.prepare(
            `UPDATE cut_pieces SET status = 'stitching', state_json = ?1, dispatched_at_ms = NULL
             WHERE id = ?2 AND status = 'shooting'`,
          )
            .bind(JSON.stringify(st), id)
            .run();
          break;
        }
        activeShotRef = active;
        stage = `shoot:${active.shot_id}:${active.status}`;

        switch (active.status) {
          case "composing": {
            if (active.dispatched_at_ms && now - active.dispatched_at_ms < STALE_STEP_MS) break;
            const cas = await env.DB.prepare(
              `UPDATE cut_shots SET dispatched_at_ms = ?1
               WHERE piece_id = ?2 AND version = ?3 AND shot_id = ?4 AND attempt = ?5
                 AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?6)`,
            )
              .bind(now, id, active.version, active.shot_id, active.attempt, active.dispatched_at_ms)
              .run();
            if ((cas.meta.changes ?? 0) === 0) break;
            await doComposeShot(ctx as Ctx, piece, doc, active);
            break;
          }

          case "generating": {
            if (!active.luma_generation_id) {
              await failShotAttempt(ctx as Ctx, piece, active, "generating without a luma id");
              break;
            }
            const gen: LumaVideoGeneration = await lumaGetGeneration(active.luma_generation_id, env);
            if (gen.state === "failed") {
              const reason = gen.failure_reason ?? gen.failure_code ?? "luma generation failed";
              await logEvent(env, id, active.version, active.shot_id, "stage_fail", "generate", { reason });
              await failShotAttempt(ctx as Ctx, piece, active, `luma: ${reason}`);
              break;
            }
            if (gen.state !== "completed") {
              return snapshot(ctx as Ctx, id, `luma:${gen.state}:${active.shot_id}`);
            }
            const cas = await env.DB.prepare(
              `UPDATE cut_shots SET status = 'ingesting', gen_latency_ms = ?1, dispatched_at_ms = ?2
               WHERE piece_id = ?3 AND version = ?4 AND shot_id = ?5 AND attempt = ?6
                 AND status = 'generating'`,
            )
              .bind(
                active.dispatched_at_ms ? now - active.dispatched_at_ms : null,
                now,
                id,
                active.version,
                active.shot_id,
                active.attempt,
              )
              .run();
            if ((cas.meta.changes ?? 0) === 0) break;
            await logEvent(env, id, active.version, active.shot_id, "stage_done", "generate", {
              ms: active.dispatched_at_ms ? now - active.dispatched_at_ms : null,
            });
            await doShotIngest(ctx as Ctx, piece, { ...active, dispatched_at_ms: now });
            break;
          }

          case "ingesting": {
            if (active.dispatched_at_ms && now - active.dispatched_at_ms < STALE_STEP_MS) break;
            const cas = await env.DB.prepare(
              `UPDATE cut_shots SET dispatched_at_ms = ?1
               WHERE piece_id = ?2 AND version = ?3 AND shot_id = ?4 AND attempt = ?5
                 AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?6)`,
            )
              .bind(now, id, active.version, active.shot_id, active.attempt, active.dispatched_at_ms)
              .run();
            if ((cas.meta.changes ?? 0) === 0) break;
            await doShotIngest(ctx as Ctx, piece, { ...active, dispatched_at_ms: now });
            break;
          }

          case "evaluating": {
            const evalState = parseJson<{ eval_id: string }>(active.eval_json);
            if (!evalState?.eval_id) {
              await failShotAttempt(ctx as Ctx, piece, active, "evaluating without an eval id");
              break;
            }
            let st: { state: string; results: unknown; error: string | null };
            try {
              st = await bridgeGet(env, `/cut/eval-status/${evalState.eval_id}`);
            } catch (e) {
              const msg = (e as Error).message;
              if (msg.includes("404") || msg.includes("unknown eval id")) {
                await redispatchShotEval(ctx as Ctx, piece, active);
                break;
              }
              throw e;
            }
            if (st.state === "running") {
              return snapshot(ctx as Ctx, id, `eval:running:${active.shot_id}`);
            }
            if (st.state === "failed") {
              await logEvent(env, id, active.version, active.shot_id, "stage_fail", "eval", {
                reason: st.error ?? "eval failed",
              });
              await failShotAttempt(ctx as Ctx, piece, active, `eval: ${st.error ?? "engine error"}`);
              break;
            }
            await doShotEvalDone(ctx as Ctx, piece, active, evalState.eval_id, (st.results ?? {}) as EngineResults);
            break;
          }

          case "judging": {
            if (active.dispatched_at_ms && now - active.dispatched_at_ms < STALE_JUDGE_MS) break;
            const cas = await env.DB.prepare(
              `UPDATE cut_shots SET dispatched_at_ms = ?1
               WHERE piece_id = ?2 AND version = ?3 AND shot_id = ?4 AND attempt = ?5
                 AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?6)`,
            )
              .bind(now, id, active.version, active.shot_id, active.attempt, active.dispatched_at_ms)
              .run();
            if ((cas.meta.changes ?? 0) === 0) break;
            await doShotJudge(ctx as Ctx, piece, doc, active);
            break;
          }

          // 'retake' / 'failed' rows are never the latest active attempt:
          // failShotAttempt inserts the successor row in the same step.
          default:
            break;
        }
        break;
      }

      case "stitching": {
        stage = "stitch";
        const doc = await getDoc(env, id, piece.current_version);
        if (!doc) {
          await failPiece(ctx as Ctx, piece, "stitching without a composition");
          break;
        }
        const state = parseJson<PieceState>(piece.state_json) ?? {};

        if (!state.stitch?.job_id) {
          // Dispatch path: elect via the piece-level step marker.
          if (piece.dispatched_at_ms && now - piece.dispatched_at_ms < STALE_STITCH_MS) break;
          const cas = await env.DB.prepare(
            `UPDATE cut_pieces SET dispatched_at_ms = ?1
             WHERE id = ?2 AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?3)`,
          )
            .bind(now, id, piece.dispatched_at_ms)
            .run();
          if ((cas.meta.changes ?? 0) === 0) break;
          await dispatchStitch(ctx as Ctx, piece, doc, 0);
          break;
        }

        // Poll path.
        let st: { state: string; results: unknown; error: string | null };
        try {
          st = await bridgeGet(env, `/cut/stitch-status/${state.stitch.job_id}`);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes("404") || msg.includes("unknown")) {
            // Bridge restarted; re-dispatch bounded.
            const retries = state.stitch.retries + 1;
            if (retries > MAX_STITCH_RETRIES) {
              await failPiece(ctx as Ctx, piece, "stitch lost repeatedly (bridge restarts)");
              break;
            }
            const cas = await env.DB.prepare(
              `UPDATE cut_pieces SET dispatched_at_ms = ?1
               WHERE id = ?2 AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?3)`,
            )
              .bind(now, id, piece.dispatched_at_ms)
              .run();
            if ((cas.meta.changes ?? 0) === 0) break;
            await dispatchStitch(ctx as Ctx, piece, doc, retries);
            break;
          }
          throw e;
        }
        if (st.state === "running") {
          return snapshot(ctx as Ctx, id, "stitch:running");
        }
        if (st.state === "failed") {
          await failPiece(ctx as Ctx, piece, `stitch: ${st.error ?? "engine error"}`);
          break;
        }
        await doStitchDone(ctx as Ctx, piece, doc, state.stitch.job_id, (st.results ?? {}) as StitchResults);
        break;
      }

      case "judging": {
        stage = "final_judge";
        const doc = await getDoc(env, id, piece.current_version);
        if (!doc) {
          await failPiece(ctx as Ctx, piece, "judging without a composition");
          break;
        }
        if (piece.dispatched_at_ms && now - piece.dispatched_at_ms < STALE_JUDGE_MS) break;
        const cas = await env.DB.prepare(
          `UPDATE cut_pieces SET dispatched_at_ms = ?1
           WHERE id = ?2 AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?3)`,
        )
          .bind(now, id, piece.dispatched_at_ms)
          .run();
        if ((cas.meta.changes ?? 0) === 0) break;
        await doFinalJudge(ctx as Ctx, piece, doc);
        break;
      }
    }
  } catch (e) {
    const msg = (e as Error).message ?? "unknown error";
    const count = await recordSoftError(ctx as Ctx, piece, stage, msg);
    if (count >= MAX_STAGE_ERRORS) {
      if (activeShotRef) {
        await failShotAttempt(ctx as Ctx, piece, activeShotRef, `${stage} failed repeatedly: ${msg}`);
      } else {
        await failPiece(ctx as Ctx, piece, `${stage} failed repeatedly: ${msg}`);
      }
    }
    return snapshot(ctx as Ctx, id, `transient:${stage}`);
  }

  return snapshot(ctx as Ctx, id);
};
