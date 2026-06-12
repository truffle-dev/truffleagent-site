// POST /api/easel/upload?board=<board_id>
// Body: raw image bytes, Content-Type: image/png|jpeg|webp|gif.
// Stores in R2 under img/<board>/<ei_id>.<ext>, returns the proxy path.

import type { EaselEnv } from "../../_easel-shared";
import {
  BOARD_ID_RE,
  DAILY_QUOTA_UPLOADS,
  MAX_UPLOAD_BYTES,
  VALID_UPLOAD_TYPES,
  bumpQuota,
  errorResponse,
  imageKey,
  imagePath,
  jsonResponse,
  newImageId,
  visitorHash,
} from "../../_easel-shared";

export const onRequestPost: PagesFunction<EaselEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const boardId = url.searchParams.get("board") ?? "";
  if (!BOARD_ID_RE.test(boardId)) return errorResponse(400, "bad_board", "malformed board id");

  const board = await ctx.env.DB.prepare(
    `SELECT id FROM easel_boards WHERE id = ?1`,
  ).bind(boardId).first<{ id: string }>();
  if (!board) return errorResponse(404, "not_found", "no such board");

  const contentType = (ctx.request.headers.get("Content-Type") ?? "").split(";")[0].trim();
  const ext = VALID_UPLOAD_TYPES[contentType];
  if (!ext) return errorResponse(415, "bad_type", "image/png, image/jpeg, image/webp, or image/gif only");

  const declared = Number(ctx.request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) {
    return errorResponse(413, "too_large", `max ${MAX_UPLOAD_BYTES} bytes`);
  }

  const bytes = await ctx.request.arrayBuffer();
  if (bytes.byteLength === 0) return errorResponse(400, "empty_body", "no image bytes");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return errorResponse(413, "too_large", `max ${MAX_UPLOAD_BYTES} bytes`);
  }

  const visitor = await visitorHash(ctx.request, ctx.env);
  const quota = await bumpQuota(ctx.env, visitor, "uploads", DAILY_QUOTA_UPLOADS);
  if (quota.over) return errorResponse(429, "daily_quota_exceeded", "upload quota reached for today");

  const imageId = newImageId();
  await ctx.env.EASEL_BUCKET.put(imageKey(boardId, imageId, ext), bytes, {
    httpMetadata: { contentType },
  });

  return jsonResponse({ ok: true, id: imageId, src: imagePath(boardId, imageId, ext) });
};
