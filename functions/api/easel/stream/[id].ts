// GET /api/easel/stream/<session_id> — SSE proxy to the bridge.
// The bridge owns the pub/sub channel; this function pipes it through so
// the browser stays same-origin. Falls back to a terminal event when the
// session is already finished (late join / reconnect after done).

import type { EaselEnv } from "../../../_easel-shared";
import { SESSION_ID_RE, errorResponse } from "../../../_easel-shared";

export const onRequestGet: PagesFunction<EaselEnv, "id"> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!SESSION_ID_RE.test(id)) return errorResponse(400, "bad_id", "malformed session id");

  const session = await ctx.env.DB.prepare(
    `SELECT id, state, result_summary FROM easel_sessions WHERE id = ?1`,
  ).bind(id).first<{ id: string; state: string; result_summary: string | null }>();
  if (!session) return errorResponse(404, "not_found", "no such session");

  const sseHeaders = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  };

  // Session already terminal: synthesize the closing event so the client
  // resolves instead of hanging on a dead channel.
  if (session.state === "done" || session.state === "failed") {
    const event = session.state === "done" ? "done" : "error_event";
    const payload = JSON.stringify(
      session.state === "done"
        ? { summary: session.result_summary || "Done." }
        : { message: session.result_summary || "The session failed." },
    );
    return new Response(`event: ${event}\ndata: ${payload}\n\n`, { headers: sseHeaders });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${ctx.env.EASEL_BRIDGE_URL}/stream/${id}`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${ctx.env.EASEL_BRIDGE_TOKEN}`,
      },
    });
  } catch {
    return errorResponse(503, "bridge_unreachable", "the agent runtime is offline right now");
  }
  if (!upstream.ok || !upstream.body) {
    return errorResponse(502, "bridge_error", `bridge stream returned ${upstream.status}`);
  }

  return new Response(upstream.body, { headers: sseHeaders });
};
