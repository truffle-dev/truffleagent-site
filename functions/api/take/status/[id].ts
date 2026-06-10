// GET /api/take/status/<id>
// The Take state machine driver. Each poll advances the piece by AT MOST one
// bounded step, then returns a full snapshot. Idempotent: concurrent polls
// race on CAS updates; losers just snapshot. Crashed steps are reclaimed via
// a dispatched_at_ms staleness window.
//
// State machine (piece.status):
//   queued/retaking -> composing  : bridge /take/compose -> luma submit -> generating
//   generating      -> poll luma  : completed -> ingesting
//   ingesting                     : video -> R2, bridge /take/eval -> evaluating
//   evaluating      -> poll bridge eval-status : done -> artifacts -> R2,
//                      gates failed -> auto-retake (judge skipped), else judging
//   judging                       : bridge /take/judge -> L3 decision ->
//                      completed | retaking | best-attempt-on-exhaustion
//
// WAIT is code, DECIDE is the agent: this file never makes a quality call.
// The composer writes the prompt, the judge reads the contact sheet, and the
// L3 rule (verdictAccepts) is a fixed threshold over the judge's levels.

import {
  type TakeEnv,
  type LumaVideoGeneration,
  type JudgeVerdict,
  MAX_ATTEMPTS,
  VALID_ASPECTS,
  DEFAULT_ASPECT,
  PIECE_ID_RE,
  videoKey,
  sheetKey,
  frameKey,
  costForClip,
  jsonResponse,
  errorResponse,
  lumaSubmitVideo,
  lumaGetGeneration,
  lumaVideoUrl,
  bridgePost,
  bridgeGet,
  bridgeGetBytes,
  verdictScore,
  verdictAccepts,
  logEvent,
} from "../../../_take-shared.ts";

const STALE_STEP_MS = 4 * 60_000;   // reclaim a crashed compose/ingest step
const STALE_JUDGE_MS = 6 * 60_000;  // judge runs ~25s; 6 min is generous
const MAX_STAGE_ERRORS = 4;         // same-stage soft errors before the attempt fails
const MAX_EVAL_RETRIES = 2;         // eval re-dispatches after bridge restart/loss

type PieceRow = {
  id: string;
  slug: string;
  prompt_raw: string;
  prompt_enhanced: string | null;
  aspect_ratio: string;
  resolution: string;
  duration: string;
  status: string;
  current_attempt: number;
  max_attempts: number;
  accepted_attempt: number | null;
  video_key: string | null;
  sheet_key: string | null;
  error_log: string | null;
  cost_usd: number;
  created_at: string;
  completed_at: string | null;
};

type AttemptRow = {
  piece_id: string;
  attempt_index: number;
  compose_json: string | null;
  luma_generation_id: string | null;
  status: string;
  video_key: string | null;
  sheet_key: string | null;
  frame_keys_json: string | null;
  eval_json: string | null;
  judge_json: string | null;
  decision: string | null;
  retake_prompt: string | null;
  failure_reason: string | null;
  cost_usd: number;
  gen_latency_ms: number | null;
  eval_latency_ms: number | null;
  dispatched_at_ms: number | null;
  completed_at: string | null;
};

type Ctx = Parameters<PagesFunction<TakeEnv>>[0];

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function durationSeconds(d: string): number {
  return d === "10s" ? 10 : 5;
}
function resolutionHeight(r: string): number {
  return r === "1080p" ? 1080 : r === "720p" ? 720 : 540;
}

// ---------- soft error accounting ----------

async function recordSoftError(
  ctx: Ctx,
  piece: PieceRow,
  attempt: number,
  stage: string,
  message: string,
): Promise<number> {
  const line = `[a${attempt}:${stage}] ${new Date().toISOString()} ${message.slice(0, 300)}`;
  const log = piece.error_log ? `${piece.error_log}\n${line}` : line;
  // keep the log bounded
  const trimmed = log.split("\n").slice(-40).join("\n");
  await ctx.env.DB.prepare(`UPDATE take_pieces SET error_log = ?1 WHERE id = ?2`)
    .bind(trimmed, piece.id)
    .run();
  piece.error_log = trimmed;
  const marker = `[a${attempt}:${stage}]`;
  return trimmed.split("\n").filter((l) => l.startsWith(marker)).length;
}

// ---------- attempt failure -> retake or terminal ----------

async function failAttempt(
  ctx: Ctx,
  piece: PieceRow,
  attemptIndex: number,
  reason: string,
  opts: { attemptStatus?: string } = {},
): Promise<void> {
  const env = ctx.env;
  const hasRetakes = attemptIndex < piece.max_attempts;
  const decision = hasRetakes ? "retake" : "abort";
  const attemptStatus = opts.attemptStatus ?? (hasRetakes ? "retake" : "failed");

  const stmts = [
    env.DB.prepare(
      `UPDATE take_attempts
         SET status = ?1, decision = ?2, failure_reason = ?3,
             completed_at = datetime('now')
       WHERE piece_id = ?4 AND attempt_index = ?5`,
    ).bind(attemptStatus, decision, reason.slice(0, 500), piece.id, attemptIndex),
  ];

  if (hasRetakes) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO take_attempts (piece_id, attempt_index, status)
         VALUES (?1, ?2, 'composing')`,
      ).bind(piece.id, attemptIndex + 1),
      env.DB.prepare(
        `UPDATE take_pieces SET status = 'retaking', current_attempt = ?1 WHERE id = ?2`,
      ).bind(attemptIndex + 1, piece.id),
    );
    await env.DB.batch(stmts);
    await logEvent(env, piece.id, attemptIndex, "decision", "retake", { reason: reason.slice(0, 300) });
    return;
  }

  // Attempts exhausted: accept the best previously-judged attempt, else fail.
  await env.DB.batch(stmts);
  await acceptBestOrFail(ctx, piece, reason);
}

async function acceptBestOrFail(ctx: Ctx, piece: PieceRow, reason: string): Promise<void> {
  const env = ctx.env;
  const rows = await env.DB.prepare(
    `SELECT attempt_index, judge_json, video_key, sheet_key
       FROM take_attempts WHERE piece_id = ?1 AND judge_json IS NOT NULL`,
  )
    .bind(piece.id)
    .all<Pick<AttemptRow, "attempt_index" | "judge_json" | "video_key" | "sheet_key">>();

  let best: { idx: number; score: number; video: string | null; sheet: string | null } | null = null;
  for (const r of rows.results ?? []) {
    const v = parseJson<JudgeVerdict>(r.judge_json);
    if (!v || !r.video_key) continue;
    const score = verdictScore(v);
    if (!best || score > best.score) {
      best = { idx: r.attempt_index, score, video: r.video_key, sheet: r.sheet_key };
    }
  }

  if (best) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE take_pieces
           SET status = 'completed', accepted_attempt = ?1, video_key = ?2,
               sheet_key = ?3, completed_at = datetime('now')
         WHERE id = ?4`,
      ).bind(best.idx, best.video, best.sheet, piece.id),
      env.DB.prepare(
        `UPDATE take_attempts SET status = 'accepted', decision = 'accept'
         WHERE piece_id = ?1 AND attempt_index = ?2`,
      ).bind(piece.id, best.idx),
    ]);
    await logEvent(ctx.env, piece.id, best.idx, "decision", "accept_best", {
      score: best.score,
      note: "attempts exhausted; best-scoring attempt accepted",
    });
    return;
  }

  await env.DB.prepare(
    `UPDATE take_pieces SET status = 'failed', completed_at = datetime('now') WHERE id = ?1`,
  )
    .bind(piece.id)
    .run();
  await logEvent(ctx.env, piece.id, piece.current_attempt, "stage_fail", "piece", {
    reason: reason.slice(0, 300),
  });
}

// ---------- step: compose + submit ----------

async function doCompose(ctx: Ctx, piece: PieceRow, attemptIndex: number): Promise<void> {
  const env = ctx.env;

  // Prior-attempt evidence for retakes: the composer must see what failed.
  let prior: Record<string, unknown> | undefined;
  if (attemptIndex > 1) {
    const prev = await env.DB.prepare(
      `SELECT compose_json, eval_json, judge_json, failure_reason
         FROM take_attempts WHERE piece_id = ?1 AND attempt_index = ?2`,
    )
      .bind(piece.id, attemptIndex - 1)
      .first<Pick<AttemptRow, "compose_json" | "eval_json" | "judge_json" | "failure_reason">>();
    if (prev) {
      const composed = parseJson<Record<string, unknown>>(prev.compose_json);
      const evalRes = parseJson<Record<string, unknown>>(prev.eval_json);
      const evalSummary: Record<string, unknown> = {};
      if (evalRes) {
        if (evalRes.gates) evalSummary.gates = evalRes.gates;
        if (evalRes.gates_passed !== undefined) evalSummary.gates_passed = evalRes.gates_passed;
        const metrics = evalRes.metrics as Record<string, { summary?: unknown }> | undefined;
        if (metrics) {
          evalSummary.metrics = Object.fromEntries(
            Object.entries(metrics).map(([k, m]) => [k, m.summary ?? null]),
          );
        }
      }
      if (prev.failure_reason) evalSummary.failure = prev.failure_reason;
      prior = {
        prompt: typeof composed?.prompt === "string" ? composed.prompt : undefined,
        eval_summary: Object.keys(evalSummary).length ? evalSummary : undefined,
        judge: parseJson<unknown>(prev.judge_json) ?? undefined,
      };
    }
  }

  const resp = await bridgePost<{
    composed: { prompt: string; aspect_ratio: string; reasoning?: string };
    cost_usd: number;
  }>(env, "/take/compose", {
    raw: piece.prompt_raw,
    attempt: attemptIndex,
    piece_id: piece.id,
    prior,
  });

  const composed = resp.composed;
  const aspect = (VALID_ASPECTS as readonly string[]).includes(composed.aspect_ratio)
    ? composed.aspect_ratio
    : DEFAULT_ASPECT;

  const gen = await lumaSubmitVideo(
    {
      prompt: composed.prompt,
      resolution: piece.resolution as never,
      duration: piece.duration as never,
      aspect_ratio: aspect as never,
    },
    env,
  );

  const stepCost = (resp.cost_usd ?? 0) + costForClip(piece.resolution, piece.duration);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE take_attempts
         SET compose_json = ?1, luma_generation_id = ?2, status = 'generating',
             dispatched_at_ms = ?3, cost_usd = cost_usd + ?4
       WHERE piece_id = ?5 AND attempt_index = ?6`,
    ).bind(
      JSON.stringify({ ...composed, aspect_ratio: aspect }),
      gen.id,
      Date.now(),
      stepCost,
      piece.id,
      attemptIndex,
    ),
    env.DB.prepare(
      `UPDATE take_pieces
         SET status = 'generating', prompt_enhanced = ?1, aspect_ratio = ?2,
             cost_usd = cost_usd + ?3
       WHERE id = ?4`,
    ).bind(composed.prompt, aspect, stepCost, piece.id),
  ]);
  await logEvent(env, piece.id, attemptIndex, "stage_done", "compose", {
    aspect_ratio: aspect,
    reasoning: composed.reasoning ?? "",
    luma_generation_id: gen.id,
  });
}

// ---------- step: ingest (luma done -> R2 -> start eval) ----------

async function doIngest(ctx: Ctx, piece: PieceRow, attempt: AttemptRow): Promise<void> {
  const env = ctx.env;
  const attemptIndex = attempt.attempt_index;
  const vKey = videoKey(piece.id, attemptIndex);

  // The R2 copy may already exist from a previous (crashed) ingest pass.
  let haveVideo = (await env.TAKE_BUCKET.head(vKey)) !== null;
  if (!haveVideo) {
    // Presigned URLs expire in 1h; re-poll the generation for a fresh one.
    const gen = await lumaGetGeneration(attempt.luma_generation_id!, env);
    const url = lumaVideoUrl(gen);
    if (!url) throw new Error("completed generation has no video url");
    const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!r.ok) throw new Error(`video download ${r.status}`);
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error("empty video download");
    await env.TAKE_BUCKET.put(vKey, bytes, {
      httpMetadata: { contentType: "video/mp4" },
    });
    haveVideo = true;
  }

  // Bridge fetches the clip from OUR url (no presign expiry, no luma creds).
  const origin = new URL(ctx.request.url).origin;
  const composed = parseJson<{ prompt: string }>(attempt.compose_json);
  const prompt = composed?.prompt ?? piece.prompt_enhanced ?? piece.prompt_raw;

  const evalResp = await bridgePost<{ eval_id: string }>(env, "/take/eval", {
    piece_id: piece.id,
    attempt: attemptIndex,
    video_url: `${origin}/v-take/${vKey}`,
    prompt,
    expected_duration_s: durationSeconds(piece.duration),
    expected_height: resolutionHeight(piece.resolution),
  });

  const priorEval = parseJson<Record<string, unknown>>(attempt.eval_json) ?? {};
  const evalState = {
    eval_id: evalResp.eval_id,
    eval_retries: (priorEval.eval_retries as number) ?? 0,
  };

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE take_attempts
         SET status = 'evaluating', video_key = ?1, eval_json = ?2, dispatched_at_ms = ?3
       WHERE piece_id = ?4 AND attempt_index = ?5`,
    ).bind(vKey, JSON.stringify(evalState), Date.now(), piece.id, attemptIndex),
    env.DB.prepare(`UPDATE take_pieces SET status = 'evaluating' WHERE id = ?1`).bind(piece.id),
  ]);
  await logEvent(env, piece.id, attemptIndex, "stage_done", "ingest", {
    video_key: vKey,
    eval_id: evalResp.eval_id,
  });
}

// ---------- step: eval results -> artifacts -> gate decision ----------

type EngineResults = {
  gates?: Array<{ name: string; passed: boolean; value: unknown }>;
  gates_passed?: boolean;
  sampled_frames?: Array<{ index: number; time_s: number; path: string }>;
  metrics?: Record<string, unknown>;
  contact_sheet?: string;
  probe?: Record<string, unknown>;
  elapsed_s?: number;
};

async function doEvalDone(
  ctx: Ctx,
  piece: PieceRow,
  attempt: AttemptRow,
  evalId: string,
  results: EngineResults,
): Promise<void> {
  const env = ctx.env;
  const attemptIndex = attempt.attempt_index;

  // Pull artifacts to R2 (idempotent puts; double-pull from racing polls is harmless).
  const sKey = sheetKey(piece.id, attemptIndex);
  try {
    const sheet = await bridgeGetBytes(env, `/take/eval-artifact/${evalId}/sheet.jpg`);
    await env.TAKE_BUCKET.put(sKey, sheet.bytes, { httpMetadata: { contentType: "image/jpeg" } });
  } catch {
    // sheet may be absent on gate-fail runs; non-fatal
  }

  const frameKeys: string[] = [];
  const frames = results.sampled_frames ?? [];
  for (let i = 0; i < frames.length; i++) {
    const bare = frames[i].path.split("/").pop()!;
    const fKey = frameKey(piece.id, attemptIndex, i);
    try {
      const img = await bridgeGetBytes(env, `/take/eval-artifact/${evalId}/${bare}`);
      await env.TAKE_BUCKET.put(fKey, img.bytes, { httpMetadata: { contentType: "image/jpeg" } });
      frameKeys.push(fKey);
    } catch {
      // skip a missing frame rather than failing the attempt
    }
  }

  const priorEval = parseJson<Record<string, unknown>>(attempt.eval_json) ?? {};
  const fullEval = { eval_id: evalId, eval_retries: priorEval.eval_retries ?? 0, ...results };
  const evalLatency = attempt.dispatched_at_ms ? Date.now() - attempt.dispatched_at_ms : null;

  if (results.gates_passed === false) {
    // Deterministic gate failure: no judge needed (cost save), straight to retake.
    await env.DB.prepare(
      `UPDATE take_attempts
         SET eval_json = ?1, sheet_key = ?2, frame_keys_json = ?3, eval_latency_ms = ?4
       WHERE piece_id = ?5 AND attempt_index = ?6`,
    )
      .bind(JSON.stringify(fullEval), sKey, JSON.stringify(frameKeys), evalLatency, piece.id, attemptIndex)
      .run();
    const failedGates = (results.gates ?? []).filter((g) => !g.passed).map((g) => g.name);
    await logEvent(env, piece.id, attemptIndex, "stage_fail", "gates", { failed: failedGates });
    await failAttempt(ctx, piece, attemptIndex, `gates failed: ${failedGates.join(", ")}`);
    return;
  }

  // CAS evaluating -> judging; loser polls just snapshot.
  const cas = await env.DB.prepare(
    `UPDATE take_pieces SET status = 'judging' WHERE id = ?1 AND status = 'evaluating'`,
  )
    .bind(piece.id)
    .run();
  if ((cas.meta.changes ?? 0) === 0) return;

  await env.DB.prepare(
    `UPDATE take_attempts
       SET status = 'judging', eval_json = ?1, sheet_key = ?2, frame_keys_json = ?3,
           eval_latency_ms = ?4, dispatched_at_ms = NULL
     WHERE piece_id = ?5 AND attempt_index = ?6`,
  )
    .bind(JSON.stringify(fullEval), sKey, JSON.stringify(frameKeys), evalLatency, piece.id, attemptIndex)
    .run();
  await logEvent(env, piece.id, attemptIndex, "stage_done", "eval", {
    gates_passed: true,
    frames: frameKeys.length,
    elapsed_s: results.elapsed_s ?? null,
  });
}

// Re-dispatch the eval after the bridge lost the job (restart wipes its
// in-memory registry). Bounded by MAX_EVAL_RETRIES.
async function redispatchEval(ctx: Ctx, piece: PieceRow, attempt: AttemptRow): Promise<boolean> {
  const env = ctx.env;
  const prior = parseJson<Record<string, unknown>>(attempt.eval_json) ?? {};
  const retries = ((prior.eval_retries as number) ?? 0) + 1;
  if (retries > MAX_EVAL_RETRIES) {
    await failAttempt(ctx, piece, attempt.attempt_index, "eval lost repeatedly (bridge restarts)");
    return false;
  }
  // CAS on dispatched_at_ms so racing polls don't double-dispatch.
  const cas = await env.DB.prepare(
    `UPDATE take_attempts SET dispatched_at_ms = ?1
     WHERE piece_id = ?2 AND attempt_index = ?3 AND dispatched_at_ms = ?4`,
  )
    .bind(Date.now(), piece.id, attempt.attempt_index, attempt.dispatched_at_ms)
    .run();
  if ((cas.meta.changes ?? 0) === 0) return false;

  const origin = new URL(ctx.request.url).origin;
  const composed = parseJson<{ prompt: string }>(attempt.compose_json);
  const evalResp = await bridgePost<{ eval_id: string }>(env, "/take/eval", {
    piece_id: piece.id,
    attempt: attempt.attempt_index,
    video_url: `${origin}/v-take/${attempt.video_key}`,
    prompt: composed?.prompt ?? piece.prompt_raw,
    expected_duration_s: durationSeconds(piece.duration),
    expected_height: resolutionHeight(piece.resolution),
  });
  await env.DB.prepare(
    `UPDATE take_attempts SET eval_json = ?1 WHERE piece_id = ?2 AND attempt_index = ?3`,
  )
    .bind(
      JSON.stringify({ eval_id: evalResp.eval_id, eval_retries: retries }),
      piece.id,
      attempt.attempt_index,
    )
    .run();
  await logEvent(env, piece.id, attempt.attempt_index, "stage_start", "eval_retry", {
    retry: retries,
    eval_id: evalResp.eval_id,
  });
  return true;
}

// ---------- step: judge -> L3 decision ----------

async function doJudge(ctx: Ctx, piece: PieceRow, attempt: AttemptRow): Promise<void> {
  const env = ctx.env;
  const attemptIndex = attempt.attempt_index;
  const evalState = parseJson<{ eval_id: string }>(attempt.eval_json);
  const composed = parseJson<{ prompt: string }>(attempt.compose_json);
  if (!evalState?.eval_id || !composed?.prompt) {
    await failAttempt(ctx, piece, attemptIndex, "judge step missing eval or compose state");
    return;
  }

  let resp: { verdict: JudgeVerdict; cost_usd: number };
  try {
    resp = await bridgePost<{ verdict: JudgeVerdict; cost_usd: number }>(env, "/take/judge", {
      piece_id: piece.id,
      attempt: attemptIndex,
      eval_id: evalState.eval_id,
      prompt: composed.prompt,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("eval_not_ready") || msg.includes("409")) {
      // Bridge restarted and lost the eval dir; fall back to re-evaluating.
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE take_pieces SET status = 'evaluating' WHERE id = ?1 AND status = 'judging'`,
        ).bind(piece.id),
        env.DB.prepare(
          `UPDATE take_attempts SET status = 'evaluating', dispatched_at_ms = 0
           WHERE piece_id = ?1 AND attempt_index = ?2`,
        ).bind(piece.id, attemptIndex),
      ]);
      return;
    }
    throw e;
  }

  const verdict = resp.verdict;
  const judgeCost = resp.cost_usd ?? 0;
  const score = verdictScore(verdict);
  const accepted = verdictAccepts(verdict);

  await logEvent(env, piece.id, attemptIndex, "decision", "judge", {
    score,
    accepted,
    axes: Object.fromEntries(
      Object.entries(verdict.axes ?? {}).map(([k, v]) => [k, v.level]),
    ),
  });

  if (accepted) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE take_attempts
           SET status = 'accepted', decision = 'accept', judge_json = ?1,
               cost_usd = cost_usd + ?2, completed_at = datetime('now')
         WHERE piece_id = ?3 AND attempt_index = ?4`,
      ).bind(JSON.stringify(verdict), judgeCost, piece.id, attemptIndex),
      env.DB.prepare(
        `UPDATE take_pieces
           SET status = 'completed', accepted_attempt = ?1, video_key = ?2,
               sheet_key = ?3, cost_usd = cost_usd + ?4, completed_at = datetime('now')
         WHERE id = ?5`,
      ).bind(attemptIndex, attempt.video_key, attempt.sheet_key, judgeCost, piece.id),
    ]);
    return;
  }

  // Rejected: persist the verdict first so best-attempt selection can see it.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE take_attempts SET judge_json = ?1, cost_usd = cost_usd + ?2
       WHERE piece_id = ?3 AND attempt_index = ?4`,
    ).bind(JSON.stringify(verdict), judgeCost, piece.id, attemptIndex),
    env.DB.prepare(`UPDATE take_pieces SET cost_usd = cost_usd + ?1 WHERE id = ?2`).bind(
      judgeCost,
      piece.id,
    ),
  ]);
  const reason =
    verdict.retake_advice?.trim() ||
    `judge rejected (score ${score}/24)`;
  await failAttempt(ctx, piece, attemptIndex, reason, { attemptStatus: "retake" });
}

// ---------- snapshot ----------

async function snapshot(ctx: Ctx, pieceId: string, note?: string): Promise<Response> {
  const env = ctx.env;
  const piece = await env.DB.prepare(`SELECT * FROM take_pieces WHERE id = ?1`)
    .bind(pieceId)
    .first<PieceRow>();
  if (!piece) return errorResponse(404, "not_found", "Unknown piece.");

  const attempts = await env.DB.prepare(
    `SELECT * FROM take_attempts WHERE piece_id = ?1 ORDER BY attempt_index ASC`,
  )
    .bind(pieceId)
    .all<AttemptRow>();

  const out = {
    ok: true,
    id: piece.id,
    slug: piece.slug,
    status: piece.status,
    current_attempt: piece.current_attempt,
    max_attempts: piece.max_attempts,
    accepted_attempt: piece.accepted_attempt,
    prompt_raw: piece.prompt_raw,
    prompt_enhanced: piece.prompt_enhanced,
    aspect_ratio: piece.aspect_ratio,
    resolution: piece.resolution,
    duration: piece.duration,
    cost_usd: Math.round(piece.cost_usd * 1000) / 1000,
    created_at: piece.created_at,
    completed_at: piece.completed_at,
    video_url: piece.video_key ? `/v-take/${piece.video_key}` : null,
    sheet_url: piece.sheet_key ? `/i-take/${piece.sheet_key}` : null,
    note: note ?? null,
    attempts: (attempts.results ?? []).map((a) => {
      const evalRes = parseJson<EngineResults & { eval_id?: string }>(a.eval_json);
      const frameKeys = parseJson<string[]>(a.frame_keys_json) ?? [];
      return {
        attempt_index: a.attempt_index,
        status: a.status,
        decision: a.decision,
        failure_reason: a.failure_reason,
        composed: parseJson<unknown>(a.compose_json),
        video_url: a.video_key ? `/v-take/${a.video_key}` : null,
        sheet_url: a.sheet_key ? `/i-take/${a.sheet_key}` : null,
        frame_urls: frameKeys.map((k) => `/i-take/${k}`),
        eval: evalRes
          ? {
              gates: evalRes.gates ?? null,
              gates_passed: evalRes.gates_passed ?? null,
              metrics: evalRes.metrics ?? null,
              probe: evalRes.probe ?? null,
              elapsed_s: evalRes.elapsed_s ?? null,
            }
          : null,
        judge: parseJson<unknown>(a.judge_json),
        retake_prompt: a.retake_prompt,
        cost_usd: Math.round(a.cost_usd * 1000) / 1000,
        gen_latency_ms: a.gen_latency_ms,
        eval_latency_ms: a.eval_latency_ms,
      };
    }),
  };
  return jsonResponse(out);
}

// ---------- driver ----------

export const onRequestGet: PagesFunction<TakeEnv> = async (ctx) => {
  const id = String(ctx.params.id ?? "");
  if (!PIECE_ID_RE.test(id)) return errorResponse(400, "invalid_id", "Malformed piece id.");
  const env = ctx.env;

  const piece = await env.DB.prepare(`SELECT * FROM take_pieces WHERE id = ?1`)
    .bind(id)
    .first<PieceRow>();
  if (!piece) return errorResponse(404, "not_found", "Unknown piece.");

  // Terminal: no work, just snapshot.
  if (piece.status === "completed" || piece.status === "failed") {
    return snapshot(ctx as Ctx, id);
  }

  const attemptIndex = piece.current_attempt;
  const attempt = await env.DB.prepare(
    `SELECT * FROM take_attempts WHERE piece_id = ?1 AND attempt_index = ?2`,
  )
    .bind(id, attemptIndex)
    .first<AttemptRow>();
  if (!attempt) {
    return snapshot(ctx as Ctx, id, "attempt row missing; will not advance");
  }

  const now = Date.now();
  let stage = piece.status;

  try {
    switch (piece.status) {
      case "queued":
      case "retaking": {
        stage = "compose";
        const cas = await env.DB.prepare(
          `UPDATE take_pieces SET status = 'composing'
           WHERE id = ?1 AND status IN ('queued','retaking')`,
        )
          .bind(id)
          .run();
        if ((cas.meta.changes ?? 0) === 0) break; // another poll owns it
        await env.DB.prepare(
          `UPDATE take_attempts SET dispatched_at_ms = ?1
           WHERE piece_id = ?2 AND attempt_index = ?3`,
        )
          .bind(now, id, attemptIndex)
          .run();
        await doCompose(ctx as Ctx, piece, attemptIndex);
        break;
      }

      case "composing": {
        stage = "compose";
        // Reclaim a crashed compose: stale dispatched marker.
        if (attempt.dispatched_at_ms && now - attempt.dispatched_at_ms < STALE_STEP_MS) break;
        const cas = await env.DB.prepare(
          `UPDATE take_attempts SET dispatched_at_ms = ?1
           WHERE piece_id = ?2 AND attempt_index = ?3
             AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?4)`,
        )
          .bind(now, id, attemptIndex, attempt.dispatched_at_ms)
          .run();
        if ((cas.meta.changes ?? 0) === 0) break;
        await doCompose(ctx as Ctx, piece, attemptIndex);
        break;
      }

      case "generating": {
        stage = "generate";
        if (!attempt.luma_generation_id) {
          await failAttempt(ctx as Ctx, piece, attemptIndex, "generating without a luma id");
          break;
        }
        const gen: LumaVideoGeneration = await lumaGetGeneration(attempt.luma_generation_id, env);
        if (gen.state === "failed") {
          const reason = gen.failure_reason ?? gen.failure_code ?? "luma generation failed";
          await logEvent(env, id, attemptIndex, "stage_fail", "generate", { reason });
          await failAttempt(ctx as Ctx, piece, attemptIndex, `luma: ${reason}`);
          break;
        }
        if (gen.state !== "completed") {
          return snapshot(ctx as Ctx, id, `luma:${gen.state}`);
        }
        // CAS generating -> ingesting, record gen latency, fresh dispatch marker.
        const cas = await env.DB.prepare(
          `UPDATE take_pieces SET status = 'ingesting' WHERE id = ?1 AND status = 'generating'`,
        )
          .bind(id)
          .run();
        if ((cas.meta.changes ?? 0) === 0) break;
        const genLatency = attempt.dispatched_at_ms ? now - attempt.dispatched_at_ms : null;
        await env.DB.prepare(
          `UPDATE take_attempts SET status = 'downloading', gen_latency_ms = ?1, dispatched_at_ms = ?2
           WHERE piece_id = ?3 AND attempt_index = ?4`,
        )
          .bind(genLatency, now, id, attemptIndex)
          .run();
        await logEvent(env, id, attemptIndex, "stage_done", "generate", { ms: genLatency });
        await doIngest(ctx as Ctx, piece, { ...attempt, dispatched_at_ms: now });
        break;
      }

      case "ingesting": {
        stage = "ingest";
        if (attempt.dispatched_at_ms && now - attempt.dispatched_at_ms < STALE_STEP_MS) break;
        const cas = await env.DB.prepare(
          `UPDATE take_attempts SET dispatched_at_ms = ?1
           WHERE piece_id = ?2 AND attempt_index = ?3
             AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?4)`,
        )
          .bind(now, id, attemptIndex, attempt.dispatched_at_ms)
          .run();
        if ((cas.meta.changes ?? 0) === 0) break;
        await doIngest(ctx as Ctx, piece, { ...attempt, dispatched_at_ms: now });
        break;
      }

      case "evaluating": {
        stage = "eval";
        const evalState = parseJson<{ eval_id: string }>(attempt.eval_json);
        if (!evalState?.eval_id) {
          await failAttempt(ctx as Ctx, piece, attemptIndex, "evaluating without an eval id");
          break;
        }
        let st: { state: string; results: unknown; error: string | null };
        try {
          st = await bridgeGet(env, `/take/eval-status/${evalState.eval_id}`);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes("404") || msg.includes("unknown eval id")) {
            // Bridge restarted; the job registry is in-memory. Re-dispatch.
            await redispatchEval(ctx as Ctx, piece, attempt);
            break;
          }
          throw e;
        }
        if (st.state === "running") {
          return snapshot(ctx as Ctx, id, "eval:running");
        }
        if (st.state === "failed") {
          await logEvent(env, id, attemptIndex, "stage_fail", "eval", {
            reason: st.error ?? "eval failed",
          });
          await failAttempt(ctx as Ctx, piece, attemptIndex, `eval: ${st.error ?? "engine error"}`);
          break;
        }
        await doEvalDone(
          ctx as Ctx,
          piece,
          attempt,
          evalState.eval_id,
          (st.results ?? {}) as EngineResults,
        );
        break;
      }

      case "judging": {
        stage = "judge";
        // Elect a judge dispatcher via the dispatched marker; reclaim stale.
        if (attempt.dispatched_at_ms && now - attempt.dispatched_at_ms < STALE_JUDGE_MS) break;
        const cas = await env.DB.prepare(
          `UPDATE take_attempts SET dispatched_at_ms = ?1
           WHERE piece_id = ?2 AND attempt_index = ?3
             AND (dispatched_at_ms IS NULL OR dispatched_at_ms = ?4)`,
        )
          .bind(now, id, attemptIndex, attempt.dispatched_at_ms)
          .run();
        if ((cas.meta.changes ?? 0) === 0) break;
        await doJudge(ctx as Ctx, piece, attempt);
        break;
      }
    }
  } catch (e) {
    const msg = (e as Error).message ?? "unknown error";
    const count = await recordSoftError(ctx as Ctx, piece, attemptIndex, stage, msg);
    if (count >= MAX_STAGE_ERRORS) {
      await failAttempt(ctx as Ctx, piece, attemptIndex, `${stage} failed repeatedly: ${msg}`);
    }
    return snapshot(ctx as Ctx, id, `transient:${stage}`);
  }

  return snapshot(ctx as Ctx, id);
};
