// GET /api/cut/events/<id>?after=<event_id>
// Replay buffer for the studio page: returns persisted cut_events rows after
// a given id (SSE only carries events while connected; this endpoint
// backfills on page load / reconnect). Also the permanent trace that the
// DAG view renders on finished pieces.

import { type CutEnv, PIECE_ID_RE, jsonResponse, errorResponse } from "../../../_cut-shared.ts";

const MAX_EVENTS = 800;

export const onRequestGet: PagesFunction<CutEnv> = async (ctx) => {
  const id = String(ctx.params.id ?? "");
  if (!PIECE_ID_RE.test(id)) return errorResponse(400, "invalid_id", "Malformed piece id.");

  const url = new URL(ctx.request.url);
  const afterRaw = url.searchParams.get("after");
  const after = afterRaw && /^\d{1,12}$/.test(afterRaw) ? Number(afterRaw) : 0;

  const rows = await ctx.env.DB.prepare(
    `SELECT id, version, shot_id, event, stage, data_json, created_at
       FROM cut_events
      WHERE piece_id = ?1 AND id > ?2
      ORDER BY id ASC
      LIMIT ?3`,
  )
    .bind(id, after, MAX_EVENTS)
    .all<{
      id: number;
      version: number;
      shot_id: string | null;
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
      version: r.version,
      shot: r.shot_id,
      event: r.event,
      stage: r.stage,
      data,
      at: r.created_at,
    };
  });

  return jsonResponse({ ok: true, events, last_id: events.length ? events[events.length - 1].id : after });
};
