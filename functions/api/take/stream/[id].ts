// GET /api/take/stream/<id>
// SSE proxy: pipes the bridge's per-piece event channel to the browser.
// Events: compose_start/compose_done, eval (stage_start/gate/frame/metric/
// stage_done), judge_start/judge_token/judge_done, plus 15s heartbeats.
// The bridge bearer never reaches the client; this function holds it.
// Pages Functions have a wall-clock cap, so the browser relies on
// EventSource auto-reconnect (bridge sends `retry: 3000`).

import { type TakeEnv, PIECE_ID_RE, errorResponse } from "../../../_take-shared.ts";

export const onRequestGet: PagesFunction<TakeEnv> = async (ctx) => {
  const id = String(ctx.params.id ?? "");
  if (!PIECE_ID_RE.test(id)) {
    return errorResponse(400, "invalid_id", "Malformed piece id.");
  }
  if (!ctx.env.TAKE_BRIDGE_URL || !ctx.env.TAKE_BRIDGE_TOKEN) {
    return errorResponse(503, "stream_unavailable", "Live agent stream is not configured.");
  }

  const upstream = ctx.env.TAKE_BRIDGE_URL.replace(/\/$/, "") + `/stream/${id}`;
  let resp: Response;
  try {
    resp = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${ctx.env.TAKE_BRIDGE_TOKEN}`,
        Accept: "text/event-stream",
      },
    });
  } catch {
    return errorResponse(502, "stream_upstream_unreachable", "Live agent stream is unreachable.");
  }
  if (!resp.ok || !resp.body) {
    return errorResponse(502, "stream_upstream_error", `Live agent stream returned ${resp.status}.`);
  }

  return new Response(resp.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};
