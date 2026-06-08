// GET /api/reel/admin/cost-rollup
// Header: Authorization: Bearer <REEL_ADMIN_SECRET>
//
// Returns a snapshot of Reel spend useful for daily ops:
//   - rolling_24h_usd: SUM(cost_usd) where created_at >= now() - 24h
//   - today_usd:       SUM(cost_usd) where date(created_at) = date('now')
//   - daily:           last 30 calendar days of (day, total_usd, piece_count)
//   - threshold_usd:   $5 alert threshold (constant; matches roadmap 1.6.2)
//   - breach:          true when rolling_24h_usd > threshold_usd
//
// Consumed by the phantom-side hourly cost-check cron: when `breach` flips
// true the cron sends an email to the operator. The endpoint itself is
// idempotent and side-effect free — alert dedup is the cron's job.
//
// Admin auth: shared bearer secret in REEL_ADMIN_SECRET. If the binding is
// missing we return 503 rather than silently allowing the call.

import {
  type ReelEnv,
  errorResponse,
  jsonResponse,
} from "../../../_reel-shared.ts";

// Roadmap 1.6.2 threshold. Co-located with the endpoint that exposes it so
// rolling the number doesn't drift between Pages and cron logic.
const ALERT_THRESHOLD_USD = 5;

const DAILY_DAYS = 30;

type DailyRow = { day: string; total_usd: number | null; piece_count: number };
type SumRow = { total_usd: number | null };

export const onRequestGet: PagesFunction<ReelEnv> = async (ctx) => {
  if (!ctx.env.REEL_ADMIN_SECRET) {
    return errorResponse(503, "service_unavailable", "Admin endpoint is not configured");
  }

  const authHeader = ctx.request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${ctx.env.REEL_ADMIN_SECRET}`;
  if (authHeader.length !== expected.length || !timingSafeEqual(authHeader, expected)) {
    return errorResponse(401, "not_authorized", "Admin auth failed");
  }

  try {
    const [rolling, today, daily] = await ctx.env.DB.batch<DailyRow | SumRow>([
      ctx.env.DB.prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total_usd
           FROM reel_pieces
          WHERE created_at >= datetime('now', '-24 hours')`,
      ),
      ctx.env.DB.prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total_usd
           FROM reel_pieces
          WHERE date(created_at) = date('now')`,
      ),
      ctx.env.DB
        .prepare(
          `SELECT date(created_at) AS day,
                  COALESCE(SUM(cost_usd), 0) AS total_usd,
                  COUNT(*) AS piece_count
             FROM reel_pieces
            WHERE created_at >= date('now', ?)
            GROUP BY day
            ORDER BY day DESC`,
        )
        .bind(`-${DAILY_DAYS} days`),
    ]);

    const rolling24h = ((rolling.results[0] as SumRow | undefined)?.total_usd ?? 0) as number;
    const todayUsd = ((today.results[0] as SumRow | undefined)?.total_usd ?? 0) as number;
    const dailyRows = ((daily.results ?? []) as DailyRow[]).map((r) => ({
      day: r.day,
      total_usd: round4(r.total_usd ?? 0),
      piece_count: r.piece_count,
    }));

    return jsonResponse({
      ok: true,
      generated_at: new Date().toISOString(),
      threshold_usd: ALERT_THRESHOLD_USD,
      rolling_24h_usd: round4(rolling24h),
      today_usd: round4(todayUsd),
      breach: rolling24h > ALERT_THRESHOLD_USD,
      daily: dailyRows,
    });
  } catch (e) {
    console.error("cost-rollup query failed:", (e as Error).message);
    return errorResponse(500, "db_query_failed", "Could not read cost rollup");
  }
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
