// GET /api/easel/gallery — list public boards, newest first.
//   ?cursor=<updated_at>|<id> for keyset pagination.
//   Returns: { ok, boards: [{ id, title, updated_at, elements, render_token }], next_cursor }
//
// Each entry carries a board-scoped render token so the gallery page can
// embed the read-only render route as a live preview. The token grants
// nothing beyond viewing a board its owner chose to make public.

import type { EaselEnv } from "../../_easel-shared";
import { jsonResponse, renderToken } from "../../_easel-shared";

const PAGE_SIZE = 24;

type Row = {
  id: string;
  title: string;
  doc: string;
  updated_at: string;
};

export const onRequestGet: PagesFunction<EaselEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const cursor = url.searchParams.get("cursor") ?? "";
  const [curTs, curId] = cursor.includes("|") ? cursor.split("|", 2) : ["", ""];

  const rows = curTs
    ? await ctx.env.DB.prepare(
        `SELECT id, title, doc, updated_at FROM easel_boards
         WHERE is_public = 1 AND (updated_at < ?1 OR (updated_at = ?1 AND id < ?2))
         ORDER BY updated_at DESC, id DESC LIMIT ?3`,
      ).bind(curTs, curId, PAGE_SIZE + 1).all<Row>()
    : await ctx.env.DB.prepare(
        `SELECT id, title, doc, updated_at FROM easel_boards
         WHERE is_public = 1
         ORDER BY updated_at DESC, id DESC LIMIT ?1`,
      ).bind(PAGE_SIZE + 1).all<Row>();

  const page = rows.results.slice(0, PAGE_SIZE);
  const hasMore = rows.results.length > PAGE_SIZE;

  const boards = await Promise.all(
    page.map(async (r) => {
      let elements = 0;
      try {
        const doc = JSON.parse(r.doc) as { elements?: unknown[] };
        elements = Array.isArray(doc.elements) ? doc.elements.length : 0;
      } catch {
        /* count stays 0 */
      }
      return {
        id: r.id,
        title: r.title,
        updated_at: r.updated_at,
        elements,
        render_token: await renderToken(r.id, ctx.env.EASEL_BRIDGE_TOKEN),
      };
    }),
  );

  const last = page[page.length - 1];
  return jsonResponse(
    {
      ok: true,
      boards,
      next_cursor: hasMore && last ? `${last.updated_at}|${last.id}` : null,
    },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=60" } },
  );
};
