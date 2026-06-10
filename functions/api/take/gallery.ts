// GET /api/take/gallery?cursor=<completed_at>|<id>&limit=24
// Public gallery: completed, visible pieces, keyset-paginated on
// (completed_at DESC, id DESC) — same shape as the Lens gallery.
// Each item carries the accepted attempt's judge verdict score so the
// gallery can show the eval receipt next to the clip.

import {
  type TakeEnv,
  type JudgeVerdict,
  jsonResponse,
  verdictScore,
} from "../../_take-shared.ts";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;

export const onRequestGet: PagesFunction<TakeEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.min(Math.max(1, Math.floor(limitRaw) || DEFAULT_LIMIT), MAX_LIMIT);

  const cursor = url.searchParams.get("cursor") ?? "";
  let where = `p.visible = 1 AND p.status = 'completed'`;
  const binds: unknown[] = [];
  const m = cursor.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|(tk_[A-Za-z0-9]{1,22})$/);
  if (m) {
    where += ` AND (p.completed_at < ?1 OR (p.completed_at = ?1 AND p.id < ?2))`;
    binds.push(m[1], m[2]);
  }

  const rows = await ctx.env.DB.prepare(
    `SELECT p.id, p.slug, p.prompt_raw, p.prompt_enhanced, p.aspect_ratio,
            p.resolution, p.duration, p.accepted_attempt, p.video_key,
            p.sheet_key, p.current_attempt, p.completed_at,
            a.judge_json
       FROM take_pieces p
       LEFT JOIN take_attempts a
         ON a.piece_id = p.id AND a.attempt_index = p.accepted_attempt
      WHERE ${where}
      ORDER BY p.completed_at DESC, p.id DESC
      LIMIT ${limit + 1}`,
  )
    .bind(...binds)
    .all<{
      id: string;
      slug: string;
      prompt_raw: string;
      prompt_enhanced: string | null;
      aspect_ratio: string;
      resolution: string;
      duration: string;
      accepted_attempt: number | null;
      video_key: string | null;
      sheet_key: string | null;
      current_attempt: number;
      completed_at: string;
      judge_json: string | null;
    }>();

  const all = rows.results ?? [];
  const page = all.slice(0, limit);
  const hasMore = all.length > limit;

  const items = page.map((r) => {
    let score: number | null = null;
    let axes: Record<string, string> | null = null;
    if (r.judge_json) {
      try {
        const v = JSON.parse(r.judge_json) as JudgeVerdict;
        score = verdictScore(v);
        axes = Object.fromEntries(
          Object.entries(v.axes ?? {}).map(([k, a]) => [k, a.level]),
        );
      } catch {
        // ignore malformed verdicts
      }
    }
    return {
      id: r.id,
      slug: r.slug,
      prompt: (r.prompt_raw ?? "").slice(0, 200),
      aspect_ratio: r.aspect_ratio,
      resolution: r.resolution,
      duration: r.duration,
      attempts: r.current_attempt,
      video_url: r.video_key ? `/v-take/${r.video_key}` : null,
      sheet_url: r.sheet_key ? `/i-take/${r.sheet_key}` : null,
      score,
      axes,
      completed_at: r.completed_at,
    };
  });

  const last = page[page.length - 1];
  const next = hasMore && last ? `${last.completed_at}|${last.id}` : null;

  return jsonResponse(
    { ok: true, items, next_cursor: next },
    {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=120, stale-while-revalidate=300",
      },
    },
  );
};
