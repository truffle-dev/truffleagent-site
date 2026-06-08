// GET /api/reel/gallery?cursor=<iso>&limit=<n>
// Public gallery feed: most recent completed + visible pieces first.
// Cursor pagination by completed_at DESC, id DESC.

import { type ReelEnv, jsonResponse } from "../../_reel-shared.ts";

type Row = {
  id: string;
  slug: string;
  character_enhanced: string | null;
  story_enhanced: string | null;
  mode: string;
  frame_count: number;
  master_ref_url: string | null;
  created_at: string;
  completed_at: string | null;
  // SQLite json_group_array aggregation: JSON-encoded array of accepted frame
  // image URLs (excluding the sentinel master at frame_index=0), ordered.
  frame_urls_json: string | null;
};

export const onRequestGet: PagesFunction<ReelEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const limit = Math.min(
    48,
    Math.max(6, Number(url.searchParams.get("limit") ?? 24) | 0),
  );
  const cursor = url.searchParams.get("cursor");

  // Defensive: the reel_pieces table may not exist yet on a freshly-deployed
  // Pages project. If the query fails (no such table), return an empty feed
  // rather than 500. The roadmap-driven cron applies migrations.
  let rows: Row[] = [];
  try {
    if (cursor) {
      const result = await ctx.env.DB.prepare(
        `SELECT p.id, p.slug, p.character_enhanced, p.story_enhanced, p.mode,
                p.frame_count, p.master_ref_url, p.created_at, p.completed_at,
                (SELECT json_group_array(f.image_url)
                   FROM (SELECT image_url FROM reel_frames
                          WHERE piece_id = p.id
                            AND status = 'accepted'
                            AND frame_index > 0
                            AND image_url IS NOT NULL
                          ORDER BY frame_index ASC) AS f) AS frame_urls_json
           FROM reel_pieces p
          WHERE p.visible = 1 AND p.status = 'completed' AND p.completed_at < ?
          ORDER BY p.completed_at DESC, p.id DESC
          LIMIT ?`,
      )
        .bind(cursor, limit + 1)
        .all<Row>();
      rows = result.results ?? [];
    } else {
      const result = await ctx.env.DB.prepare(
        `SELECT p.id, p.slug, p.character_enhanced, p.story_enhanced, p.mode,
                p.frame_count, p.master_ref_url, p.created_at, p.completed_at,
                (SELECT json_group_array(f.image_url)
                   FROM (SELECT image_url FROM reel_frames
                          WHERE piece_id = p.id
                            AND status = 'accepted'
                            AND frame_index > 0
                            AND image_url IS NOT NULL
                          ORDER BY frame_index ASC) AS f) AS frame_urls_json
           FROM reel_pieces p
          WHERE p.visible = 1 AND p.status = 'completed'
          ORDER BY p.completed_at DESC, p.id DESC
          LIMIT ?`,
      )
        .bind(limit + 1)
        .all<Row>();
      rows = result.results ?? [];
    }
  } catch (e) {
    return jsonResponse(
      { ok: true, items: [], next_cursor: null, _info: "table_not_ready" },
      {
        headers: {
          "Cache-Control":
            "public, max-age=60, s-maxage=120, stale-while-revalidate=300",
        },
      },
    );
  }

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => {
    let frame_urls: string[] = [];
    if (r.frame_urls_json) {
      try {
        const parsed = JSON.parse(r.frame_urls_json);
        if (Array.isArray(parsed)) {
          frame_urls = parsed.filter((u): u is string => typeof u === "string" && u.length > 0);
        }
      } catch {
        frame_urls = [];
      }
    }
    return {
      id: r.id,
      slug: r.slug,
      character_enhanced: r.character_enhanced,
      story_enhanced: r.story_enhanced,
      mode: r.mode,
      frame_count: r.frame_count,
      master_url: r.master_ref_url,
      frame_urls,
      permalink: `${url.origin}/reel/${r.slug}/`,
      created_at: r.created_at,
      completed_at: r.completed_at,
    };
  });
  const next_cursor = hasMore ? items[items.length - 1].completed_at : null;

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
