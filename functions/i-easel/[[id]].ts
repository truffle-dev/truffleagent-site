// GET /i-easel/img/<board_id>/<image_id>.<ext>
// R2 proxy for Easel canvas images (uploads + Luma generations).
// Keys are content-addressed and immutable: 1-year cache + ETag.

import type { EaselEnv } from "../_easel-shared";
import { BOARD_ID_RE, IMAGE_ID_RE } from "../_easel-shared";

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const onRequestGet: PagesFunction<EaselEnv> = async (ctx) => {
  const parts = (ctx.params.id as string[] | undefined) ?? [];
  // Expect ["img", "<board_id>", "<image_id>.<ext>"]
  if (parts.length !== 3 || parts[0] !== "img") {
    return new Response("Not found", { status: 404 });
  }
  const [, boardId, file] = parts;
  const m = /^([a-z0-9_]+)\.([a-z0-9]+)$/.exec(file);
  if (!m || !BOARD_ID_RE.test(boardId) || !IMAGE_ID_RE.test(m[1]) || !(m[2] in CONTENT_TYPES)) {
    return new Response("Bad key", { status: 400 });
  }

  const key = `img/${boardId}/${file}`;
  const obj = await ctx.env.EASEL_BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Etag", `"${obj.etag}"`);
  headers.set("Content-Type", CONTENT_TYPES[m[2]]);

  const ifNoneMatch = ctx.request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch === `"${obj.etag}"`) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { headers });
};
