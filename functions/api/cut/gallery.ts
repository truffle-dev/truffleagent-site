// GET /api/cut/gallery?before=<completed_at>|<id>
// Public gallery: completed, visible pieces, keyset-paginated on
// (completed_at DESC, id DESC), 30 per page. The cursor is the last row's
// `completed_at|id`; pass it back as ?before= to get the next page.
// Response: { ok, pieces: [...], next_before } where next_before is null
// when the page is the last one.

import {
  type CutEnv,
  isValidPieceId,
  jsonResponse,
} from "../../_cut-shared.ts";

const PAGE_SIZE = 30;

// D1 datetime('now') shape: "YYYY-MM-DD HH:MM:SS".
const COMPLETED_AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export const onRequestGet: PagesFunction<CutEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);

  let where = `visible = 1 AND status = 'completed'`;
  const binds: unknown[] = [];

  const before = url.searchParams.get("before") ?? "";
  if (before) {
    const sep = before.indexOf("|");
    const ts = sep >= 0 ? before.slice(0, sep) : "";
    const id = sep >= 0 ? before.slice(sep + 1) : "";
    if (COMPLETED_AT_RE.test(ts) && isValidPieceId(id)) {
      where += ` AND (completed_at < ?1 OR (completed_at = ?1 AND id < ?2))`;
      binds.push(ts, id);
    }
    // Malformed cursors fall through to page one rather than erroring.
  }

  const rows = await ctx.env.DB.prepare(
    `SELECT id, slug, title, prompt_raw, target_seconds, final_score,
            cost_usd, completed_at, final_key, final_sheet_key
       FROM cut_pieces
      WHERE ${where}
      ORDER BY completed_at DESC, id DESC
      LIMIT ${PAGE_SIZE + 1}`,
  )
    .bind(...binds)
    .all<{
      id: string;
      slug: string;
      title: string | null;
      prompt_raw: string;
      target_seconds: number;
      final_score: number | null;
      cost_usd: number;
      completed_at: string;
      final_key: string | null;
      final_sheet_key: string | null;
    }>();

  const all = rows.results ?? [];
  const page = all.slice(0, PAGE_SIZE);
  const hasMore = all.length > PAGE_SIZE;

  const pieces = page.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    prompt_raw: (r.prompt_raw ?? "").slice(0, 200),
    target_seconds: r.target_seconds,
    final_score: r.final_score,
    cost_usd: r.cost_usd,
    completed_at: r.completed_at,
    poster_url: r.final_sheet_key ? `/i-cut/${r.final_sheet_key}` : null,
    final_url: r.final_key ? `/v-cut/${r.final_key}` : null,
  }));

  const last = page[page.length - 1];
  const nextBefore = hasMore && last ? `${last.completed_at}|${last.id}` : null;

  return jsonResponse(
    { ok: true, pieces, next_before: nextBefore },
    {
      headers: {
        "Cache-Control":
          "public, max-age=60, s-maxage=120, stale-while-revalidate=300",
      },
    },
  );
};
