// GET /api/reel/stream/<id>
// SSE proxy: subscribes to the bridge's per-piece event channel
// (GET <REEL_BRIDGE_URL>/stream/<id>) and pipes the stream to the browser.
// The draft page's "Watch the agent" panel consumes this with EventSource.
//
// The bridge bearer token never reaches the client; this function holds it.
// Events: hello, inspect_start, inspect_verdict, inspect_error, plus
// 15s heartbeat comments from the bridge. Pages Functions run in V8
// isolates with a wall-clock cap, so the browser side must rely on
// EventSource auto-reconnect (the bridge sends `retry: 3000`).

import { type ReelEnv, PIECE_ID_RE, errorResponse } from "../../../_reel-shared.ts";

export const onRequestGet: PagesFunction<ReelEnv> = async (ctx) => {
  const id = String(ctx.params.id ?? "");
  if (!PIECE_ID_RE.test(id)) {
    return errorResponse(400, "invalid_id", "Malformed piece id.");
  }
  if (!ctx.env.REEL_BRIDGE_URL || !ctx.env.REEL_BRIDGE_TOKEN) {
    return errorResponse(503, "stream_unavailable", "Live agent stream is not configured.");
  }

  const upstream = ctx.env.REEL_BRIDGE_URL.replace(/\/$/, "") + `/stream/${id}`;
  let resp: Response;
  try {
    resp = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${ctx.env.REEL_BRIDGE_TOKEN}`,
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
