// POST /api/reel/admin/visibility
// Body: { piece_id: string, visible: 0 | 1 }
// Header: Authorization: Bearer <REEL_ADMIN_SECRET>
//
// Toggle the `visible` flag on a reel piece. Hidden pieces are filtered
// out of the public gallery and the reader view returns 404 for them.
// The draft view also drops the public-cache header when visible=0.
//
// This is the only admin write on Reel right now. Auth is a single shared
// secret; the secret is set via `wrangler pages secret put REEL_ADMIN_SECRET`
// out-of-band. If the secret binding is missing, the endpoint returns 503
// rather than silently allowing the call.

import {
  type ReelEnv,
  errorResponse,
  jsonResponse,
} from "../../../_reel-shared.ts";

type Body = {
  piece_id?: string;
  visible?: 0 | 1 | boolean;
};

const PIECE_ID_RE = /^rl_[A-Za-z0-9]{1,22}$/;

export const onRequestPost: PagesFunction<ReelEnv> = async (ctx) => {
  if (!ctx.env.REEL_ADMIN_SECRET) {
    return errorResponse(503, "service_unavailable", "Admin endpoint is not configured");
  }

  const authHeader = ctx.request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${ctx.env.REEL_ADMIN_SECRET}`;
  // Length-prefix check before constant-time compare. Reject obvious mismatches
  // without leaking secret length, but spend the constant-time on equal-length.
  if (authHeader.length !== expected.length || !timingSafeEqual(authHeader, expected)) {
    return errorResponse(401, "not_authorized", "Admin auth failed");
  }

  let body: Body;
  try {
    body = (await ctx.request.json()) as Body;
  } catch {
    return errorResponse(400, "bad_json", "Body must be JSON");
  }

  const pieceId = (body.piece_id ?? "").trim();
  if (!pieceId || !PIECE_ID_RE.test(pieceId)) {
    return errorResponse(400, "bad_id", "piece_id must look like rl_<id>");
  }

  let visible: 0 | 1;
  if (body.visible === 0 || body.visible === false) visible = 0;
  else if (body.visible === 1 || body.visible === true) visible = 1;
  else return errorResponse(400, "bad_visible", "visible must be 0 or 1");

  const existing = await ctx.env.DB
    .prepare(`SELECT id, visible FROM reel_pieces WHERE id = ?`)
    .bind(pieceId)
    .first<{ id: string; visible: number }>();
  if (!existing) return errorResponse(404, "not_found", "No piece with that id");

  if (existing.visible === visible) {
    return jsonResponse({ ok: true, piece_id: pieceId, visible, changed: false });
  }

  try {
    await ctx.env.DB
      .prepare(`UPDATE reel_pieces SET visible = ? WHERE id = ?`)
      .bind(visible, pieceId)
      .run();
  } catch (e) {
    console.error("admin visibility update failed:", (e as Error).message);
    return errorResponse(500, "db_update_failed", "Could not update the piece");
  }

  return jsonResponse({ ok: true, piece_id: pieceId, visible, changed: true });
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
