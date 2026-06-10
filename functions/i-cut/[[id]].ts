// GET /i-cut/sheet/<piece>/v<version>/<shot>/<attempt>.jpg      (shot contact sheet)
// GET /i-cut/frame/<piece>/v<version>/<shot>/<attempt>/<n>.jpg  (sampled frame)
// GET /i-cut/fsheet/<piece>/v<version>.jpg                      (final contact sheet)
// GET /i-cut/seams/<piece>/v<version>.jpg                       (seam boundary sheet)
// R2 image proxy. Keys are immutable once written, so cache hard.
// Double-bracket catch-all: keys contain slashes. The frame URLs double as
// Luma start_frame conditioning images, so they must be publicly fetchable.

import { type CutEnv, errorResponse } from "../_cut-shared.ts";

const P = "cu_[A-Za-z0-9]{1,22}";
const KEY_RE = new RegExp(
  `^(sheet\\/${P}\\/v\\d{1,2}\\/s[1-9]\\/\\d{1,2}\\.jpg` +
    `|frame\\/${P}\\/v\\d{1,2}\\/s[1-9]\\/\\d{1,2}\\/\\d{1,3}\\.jpg` +
    `|fsheet\\/${P}\\/v\\d{1,2}\\.jpg` +
    `|seams\\/${P}\\/v\\d{1,2}\\.jpg)$`,
);

export const onRequestGet: PagesFunction<CutEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/i-cut\//, ""));
  if (!KEY_RE.test(key)) return errorResponse(404, "not_found", "No such image.");

  const inm = ctx.request.headers.get("If-None-Match");
  const obj = inm
    ? await ctx.env.CUT_BUCKET.get(key, { onlyIf: { etagDoesNotMatch: inm.replace(/"/g, "") } })
    : await ctx.env.CUT_BUCKET.get(key);
  if (!obj) return errorResponse(404, "not_found", "No such image.");

  const headers: Record<string, string> = {
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: obj.httpEtag,
  };

  if (!("body" in obj) || !obj.body) {
    // onlyIf matched: R2 returns the object metadata without a body -> 304
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { status: 200, headers });
};
