// POST /api/easel/internal/finalize — bridge-only callback.
// Body: { session_id, state: "done"|"failed", summary, cost_usd }
// Authorized by the shared bridge bearer token (EASEL_BRIDGE_TOKEN). The
// bridge calls this once at session end so D1 reflects the terminal state
// even if every SSE client has disconnected.

import type { EaselEnv } from "../../../_easel-shared";
import { SESSION_ID_RE, errorResponse, jsonResponse } from "../../../_easel-shared";

export const onRequestPost: PagesFunction<EaselEnv> = async (ctx) => {
  const auth = ctx.request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== ctx.env.EASEL_BRIDGE_TOKEN) {
    return errorResponse(401, "unauthorized", "bad or missing bearer token");
  }

  let body: Record<string, unknown>;
  try {
    body = (await ctx.request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_json", "body must be JSON");
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  if (!SESSION_ID_RE.test(sessionId)) return errorResponse(400, "bad_id", "malformed session id");

  const state = body.state === "done" ? "done" : body.state === "failed" ? "failed" : "";
  if (!state) return errorResponse(400, "bad_state", "state must be done or failed");

  const summary = typeof body.summary === "string" ? body.summary.slice(0, 600) : "";
  const costUsd =
    typeof body.cost_usd === "number" && Number.isFinite(body.cost_usd) && body.cost_usd >= 0
      ? body.cost_usd
      : 0;

  const res = await ctx.env.DB.prepare(
    `UPDATE easel_sessions
     SET state = ?2, result_summary = ?3, cost_usd = ?4, finished_at = datetime('now')
     WHERE id = ?1 AND state IN ('queued','running')`,
  ).bind(sessionId, state, summary, costUsd).run();

  if (!res.meta.changes) {
    // Already terminal or unknown id — idempotent no-op either way.
    const existing = await ctx.env.DB.prepare(
      `SELECT id FROM easel_sessions WHERE id = ?1`,
    ).bind(sessionId).first<{ id: string }>();
    if (!existing) return errorResponse(404, "not_found", "no such session");
  }

  return jsonResponse({ ok: true });
};
