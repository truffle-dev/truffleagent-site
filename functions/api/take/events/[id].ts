// GET /api/take/events/<id>?after=<event_id>
// Replay buffer for the live page: returns the persisted take_events rows
// after a given id (SSE only carries events while connected; this endpoint
// backfills history on page load / reconnect). Also the permanent eval
// trace rendered on the finished piece page.

import { type TakeEnv, PIECE_ID_RE, jsonResponse, errorResponse } from "../../../_take-shared.ts";

const MAX_EVENTS = 500;

export const onRequestGet: PagesFunction<TakeEnv> = async (ctx) => {
  const id = String(ctx.params.id ?? "");
  if (!PIECE_ID_RE.test(id)) return errorResponse(400, "invalid_id", "Malformed piece id.");

  const url = new URL(ctx.request.url);
  const afterRaw = url.searchParams.get("after");
  const after = afterRaw && /^\d{1,12}$/.test(afterRaw) ? Number(afterRaw) : 0;

  const rows = await ctx.env.DB.prepare(
    `SELECT id, attempt_index, event, stage, data_json, created_at
       FROM take_events
      WHERE piece_id = ?1 AND id > ?2
      ORDER BY id ASC
      LIMIT ?3`,
  )
    .bind(id, after, MAX_EVENTS)
    .all<{
      id: number;
      attempt_index: number;
      event: string;
      stage: string;
      data_json: string | null;
      created_at: string;
    }>();

  const events = (rows.results ?? []).map((r) => {
    let data: unknown = null;
    try {
      data = r.data_json ? JSON.parse(r.data_json) : null;
    } catch {
      data = null;
    }
    return {
      id: r.id,
      attempt: r.attempt_index,
      event: r.event,
      stage: r.stage,
      data,
      at: r.created_at,
    };
  });

  return jsonResponse({ ok: true, events, last_id: events.length ? events[events.length - 1].id : after });
};
