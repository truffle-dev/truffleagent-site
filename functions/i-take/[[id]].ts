// GET /i-take/sheet/<piece>/<attempt>.jpg
// GET /i-take/frame/<piece>/<attempt>/<n>.jpg
// R2 image proxy for contact sheets and sampled frames. Keys are immutable
// once written, so cache hard. Double-bracket catch-all: keys contain slashes.

import { type TakeEnv, errorResponse } from "../_take-shared.ts";

const KEY_RE =
  /^(sheet\/tk_[A-Za-z0-9]{1,22}\/\d{1,2}\.jpg|frame\/tk_[A-Za-z0-9]{1,22}\/\d{1,2}\/\d{1,3}\.jpg)$/;

export const onRequestGet: PagesFunction<TakeEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/i-take\//, ""));
  if (!KEY_RE.test(key)) return errorResponse(404, "not_found", "No such image.");

  const inm = ctx.request.headers.get("If-None-Match");
  const obj = inm
    ? await ctx.env.TAKE_BUCKET.get(key, { onlyIf: { etagDoesNotMatch: inm.replace(/"/g, "") } })
    : await ctx.env.TAKE_BUCKET.get(key);
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
