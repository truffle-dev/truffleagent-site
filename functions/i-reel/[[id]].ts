// GET /i-reel/<key>
// Streams an R2 object from the truffle-reel-images bucket with a long-lived
// immutable cache. The <key> path segment can be one of:
//   master/<piece_id>.png
//   frame/<piece_id>/<frame_index>.png
//   frame/<piece_id>/<frame_index>-attempt-<n>.png
// The file is named [[id]].ts (catch-all), so Cloudflare Pages routes
// every path under /i-reel/ here regardless of segment count.

import { type ReelEnv } from "../_reel-shared.ts";

export const onRequestGet: PagesFunction<ReelEnv> = async (ctx) => {
  // We read url.pathname rather than params.id because under a catch-all
  // route, params.id is a string[] of the segments. The key shape we want
  // ("master/<id>.png" or "frame/<id>/<n>.png") is just the tail joined
  // by "/", which is exactly what slicing the prefix off the pathname gives.
  const url = new URL(ctx.request.url);
  const prefix = "/i-reel/";
  if (!url.pathname.startsWith(prefix)) {
    return new Response("not found", { status: 404 });
  }
  const key = url.pathname.slice(prefix.length);
  if (!key || key.length > 200) {
    return new Response("bad key", { status: 400 });
  }
  // Whitelist the key shape: only PNGs, only under master/ or frame/.
  if (!/^(master|frame)\/[a-zA-Z0-9_\-\/]+\.png$/.test(key)) {
    return new Response("bad key shape", { status: 400 });
  }

  const obj = await ctx.env.REEL_BUCKET.get(key, {
    onlyIf: ctx.request.headers.get("if-none-match")
      ? { etagMatches: ctx.request.headers.get("if-none-match") ?? undefined }
      : undefined,
  });

  if (!obj) {
    return new Response("not found", { status: 404 });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Etag", obj.httpEtag);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "image/png");

  // If the R2 SDK returned a 304-like signal (body absent), respond 304.
  if (!obj.body) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(obj.body, { headers });
};
