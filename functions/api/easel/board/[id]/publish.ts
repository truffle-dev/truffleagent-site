// POST /api/easel/board/<id>/publish — toggle gallery visibility.
//   Body: { public: boolean }
//   Returns: { ok: true, is_public: boolean }
//
// Authority model matches the rest of the board API: knowing the board id
// is the capability. Note: unpublishing removes the board from the gallery
// listing; previously minted render tokens stay valid (board-scoped,
// read-only — same reach as anyone who ever had the board link).

import type { EaselEnv } from "../../../../_easel-shared";
import { BOARD_ID_RE, errorResponse, jsonResponse } from "../../../../_easel-shared";

export const onRequestPost: PagesFunction<EaselEnv, "id"> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!BOARD_ID_RE.test(id)) return errorResponse(400, "bad_id", "malformed board id");

  let body: { public?: unknown };
  try {
    body = await ctx.request.json();
  } catch {
    return errorResponse(400, "bad_json", "body must be JSON");
  }
  if (typeof body.public !== "boolean") {
    return errorResponse(400, "bad_public", "public must be a boolean");
  }

  const result = await ctx.env.DB.prepare(
    `UPDATE easel_boards SET is_public = ?1, updated_at = datetime('now') WHERE id = ?2`,
  ).bind(body.public ? 1 : 0, id).run();

  if (!result.meta.changes) return errorResponse(404, "not_found", "no such board");

  return jsonResponse({ ok: true, is_public: body.public });
};
