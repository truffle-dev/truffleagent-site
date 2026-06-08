// GET /audio-reel/<key>
// Streams an R2 object from the truffle-reel-images bucket with a long-lived
// immutable cache. Key shape is narration/<piece_id>.mp3 today; the catch-all
// route preserves nested path flexibility for future narration variants
// (e.g. narration/<piece_id>/<voice_id>.mp3).

import { type ReelEnv } from "../_reel-shared.ts";

export const onRequestGet: PagesFunction<ReelEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const prefix = "/audio-reel/";
  if (!url.pathname.startsWith(prefix)) {
    return new Response("not found", { status: 404 });
  }
  const key = url.pathname.slice(prefix.length);
  if (!key || key.length > 200) {
    return new Response("bad key", { status: 400 });
  }
  if (!/^narration\/[a-zA-Z0-9_\-\/]+\.mp3$/.test(key)) {
    return new Response("bad key shape", { status: 400 });
  }

  const ifNoneMatch = ctx.request.headers.get("if-none-match");
  const obj = await ctx.env.REEL_BUCKET.get(key, {
    onlyIf: ifNoneMatch ? { etagMatches: ifNoneMatch } : undefined,
  });

  if (!obj) {
    return new Response("not found", { status: 404 });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Etag", obj.httpEtag);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "audio/mpeg");
  headers.set("Accept-Ranges", "bytes");

  if (!obj.body) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(obj.body, { headers });
};
