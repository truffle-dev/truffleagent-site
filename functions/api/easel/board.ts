// POST /api/easel/board — create a new board.
// Body: { title? }
// Returns: { ok: true, id, version }

import type { EaselEnv } from "../../_easel-shared";
import {
  MAX_TITLE_CHARS,
  emptyDoc,
  errorResponse,
  jsonResponse,
  newBoardId,
  visitorHash,
} from "../../_easel-shared";

export const onRequestPost: PagesFunction<EaselEnv> = async (ctx) => {
  let body: { title?: unknown } = {};
  try {
    body = await ctx.request.json();
  } catch {
    // empty body is fine
  }
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, MAX_TITLE_CHARS)
      : "Untitled board";

  const id = newBoardId();
  const visitor = await visitorHash(ctx.request, ctx.env);
  try {
    await ctx.env.DB.prepare(
      `INSERT INTO easel_boards (id, title, doc, version, visitor_hash)
       VALUES (?1, ?2, ?3, 1, ?4)`,
    ).bind(id, title, JSON.stringify(emptyDoc()), visitor).run();
  } catch (err) {
    return errorResponse(500, "db_error", `could not create board: ${String(err)}`);
  }
  return jsonResponse({ ok: true, id, version: 1 });
};
