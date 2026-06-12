// POST /api/easel/agent — start an agent session on a board.
// Body: { board_id, prompt }
// Returns: { ok: true, session_id }
//
// The heavy lifting happens on the Bun bridge (claude CLI subprocess with
// board-scoped MCP tools). This function validates, applies quota, creates
// the session row, and hands off to the bridge.

import type { EaselEnv } from "../../_easel-shared";
import {
  BOARD_ID_RE,
  DAILY_QUOTA_SESSIONS,
  MAX_PROMPT_CHARS,
  errorResponse,
  jsonResponse,
  newSessionId,
  visitorHash,
  bumpQuota,
} from "../../_easel-shared";

export const onRequestPost: PagesFunction<EaselEnv> = async (ctx) => {
  let body: { board_id?: unknown; prompt?: unknown };
  try {
    body = await ctx.request.json();
  } catch {
    return errorResponse(400, "bad_json", "body must be JSON");
  }

  const boardId = typeof body.board_id === "string" ? body.board_id : "";
  if (!BOARD_ID_RE.test(boardId)) return errorResponse(400, "bad_board", "malformed board id");

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return errorResponse(400, "missing_prompt", "prompt required");
  if (prompt.length > MAX_PROMPT_CHARS) {
    return errorResponse(413, "prompt_too_long", `max ${MAX_PROMPT_CHARS} characters`);
  }

  const board = await ctx.env.DB.prepare(
    `SELECT id FROM easel_boards WHERE id = ?1`,
  ).bind(boardId).first<{ id: string }>();
  if (!board) return errorResponse(404, "not_found", "no such board");

  // One agent at a time per board.
  const running = await ctx.env.DB.prepare(
    `SELECT id FROM easel_sessions
     WHERE board_id = ?1 AND state IN ('queued','running')
       AND created_at > datetime('now', '-15 minutes')`,
  ).bind(boardId).first<{ id: string }>();
  if (running) {
    return errorResponse(409, "session_active", "an agent session is already running on this board");
  }

  const visitor = await visitorHash(ctx.request, ctx.env);
  const quota = await bumpQuota(ctx.env, visitor, "sessions", DAILY_QUOTA_SESSIONS);
  if (quota.over) {
    return errorResponse(429, "daily_quota_exceeded", "agent session quota reached for today");
  }

  const sessionId = newSessionId();
  await ctx.env.DB.prepare(
    `INSERT INTO easel_sessions (id, board_id, prompt, state, visitor_hash)
     VALUES (?1, ?2, ?3, 'queued', ?4)`,
  ).bind(sessionId, boardId, prompt, visitor).run();

  // Hand off to the bridge. The bridge mutates the board through the same
  // public board API the browser uses (version-guarded), and publishes the
  // event stream at /stream/<session_id>.
  const origin = new URL(ctx.request.url).origin;
  let bridgeRes: Response;
  try {
    bridgeRes = await fetch(`${ctx.env.EASEL_BRIDGE_URL}/easel/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.env.EASEL_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({
        session_id: sessionId,
        board_id: boardId,
        prompt,
        site_base: origin,
      }),
    });
  } catch (err) {
    await ctx.env.DB.prepare(
      `UPDATE easel_sessions SET state = 'failed', finished_at = datetime('now'),
       result_summary = ?2 WHERE id = ?1`,
    ).bind(sessionId, `bridge unreachable: ${String(err).slice(0, 200)}`).run();
    return errorResponse(503, "bridge_unreachable", "the agent runtime is offline right now");
  }

  if (!bridgeRes.ok) {
    const detail = (await bridgeRes.text().catch(() => "")).slice(0, 200);
    await ctx.env.DB.prepare(
      `UPDATE easel_sessions SET state = 'failed', finished_at = datetime('now'),
       result_summary = ?2 WHERE id = ?1`,
    ).bind(sessionId, `bridge ${bridgeRes.status}: ${detail}`).run();
    return errorResponse(502, "bridge_error", "the agent runtime rejected the session");
  }

  await ctx.env.DB.prepare(
    `UPDATE easel_sessions SET state = 'running' WHERE id = ?1`,
  ).bind(sessionId).run();

  return jsonResponse({ ok: true, session_id: sessionId });
};
