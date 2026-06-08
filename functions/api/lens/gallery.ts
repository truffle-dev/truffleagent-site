// GET /api/lens/gallery?cursor=<id>&limit=<n>
// Public gallery feed: most recent completed + visible generations first.
// Cursor pagination by created_at DESC, id DESC.

import { type LensEnv, jsonResponse } from "../../_lens-shared.ts";

type Row = {
  id: string;
  prompt_raw: string;
  prompt_enhanced: string | null;
  model: string;
  aspect_ratio: string;
  created_at: string;
  completed_at: string | null;
};

export const onRequestGet: PagesFunction<LensEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const limit = Math.min(48, Math.max(6, Number(url.searchParams.get("limit") ?? 24) | 0));
  const cursor = url.searchParams.get("cursor"); // ISO datetime: "2026-06-07T16:42:00Z"

  let rows: Row[];
  if (cursor) {
    const result = await ctx.env.DB
      .prepare(
        `SELECT id, prompt_raw, prompt_enhanced, model, aspect_ratio, created_at, completed_at
           FROM lens_generations
          WHERE visible = 1 AND status = 'completed' AND completed_at < ?
          ORDER BY completed_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(cursor, limit + 1)
      .all<Row>();
    rows = result.results ?? [];
  } else {
    const result = await ctx.env.DB
      .prepare(
        `SELECT id, prompt_raw, prompt_enhanced, model, aspect_ratio, created_at, completed_at
           FROM lens_generations
          WHERE visible = 1 AND status = 'completed'
          ORDER BY completed_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(limit + 1)
      .all<Row>();
    rows = result.results ?? [];
  }

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    prompt_raw: r.prompt_raw,
    prompt_enhanced: r.prompt_enhanced,
    model: r.model,
    aspect_ratio: r.aspect_ratio,
    url: `${url.origin}/i/${r.id}`,
    created_at: r.created_at,
    completed_at: r.completed_at,
  }));
  const next_cursor = hasMore ? items[items.length - 1].completed_at : null;

  // Edge caches for 120s and serves stale up to 5 min while it refetches.
  // The client prepends just-generated tiles directly, so a stale gallery
  // page never hides a fresh image.
  return jsonResponse(
    { ok: true, items, next_cursor },
    {
      headers: {
        "Cache-Control":
          "public, max-age=60, s-maxage=120, stale-while-revalidate=300",
      },
    },
  );
};
