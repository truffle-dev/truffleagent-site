// GET /api/cut/stream/<id>
// SSE proxy: pipes the bridge's per-piece event channel to the browser.
// Events: plan/compose/eval/judge/stitch/seam lifecycle markers plus 15s
// heartbeats. The bridge bearer never reaches the client; this function
// holds it. Pages Functions have a wall-clock cap, so the browser relies
// on EventSource auto-reconnect (bridge sends `retry: 3000`).

import { type CutEnv, PIECE_ID_RE, errorResponse } from "../../../_cut-shared.ts";

export const onRequestGet: PagesFunction<CutEnv> = async (ctx) => {
  const id = String(ctx.params.id ?? "");
  if (!PIECE_ID_RE.test(id)) {
    return errorResponse(400, "invalid_id", "Malformed piece id.");
  }
  if (!ctx.env.CUT_BRIDGE_URL || !ctx.env.CUT_BRIDGE_TOKEN) {
    return errorResponse(503, "stream_unavailable", "Live agent stream is not configured.");
  }

  const upstream = ctx.env.CUT_BRIDGE_URL.replace(/\/$/, "") + `/stream/${id}`;
  let resp: Response;
  try {
    resp = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${ctx.env.CUT_BRIDGE_TOKEN}`,
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
