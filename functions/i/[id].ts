// GET /i/<lens_id>
// Stream the R2-stored PNG with long-lived caching. Content-addressed by id,
// so any successful response is safe to cache forever.

import { type LensEnv } from "../_lens-shared.ts";

export const onRequestGet: PagesFunction<LensEnv, "id"> = async (ctx) => {
  const id = ctx.params.id;
  if (typeof id !== "string" || !/^lg_[a-z0-9]{8,}$/.test(id)) {
    return new Response("Bad id", { status: 400 });
  }

  const r2Key = `i/${id}.png`;
  const obj = await ctx.env.LENS_BUCKET.get(r2Key);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  if (obj.httpMetadata?.contentType) headers.set("Content-Type", obj.httpMetadata.contentType);
  else headers.set("Content-Type", "image/png");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Content-Length", String(obj.size));
  if (obj.etag) headers.set("Etag", `"${obj.etag}"`);
  // Allow direct hotlinks; the image is fully public.
  headers.set("Access-Control-Allow-Origin", "*");
  // Conditional GET — if the browser already has it, 304 it.
  const ifNoneMatch = ctx.request.headers.get("If-None-Match");
  if (ifNoneMatch && obj.etag && ifNoneMatch === `"${obj.etag}"`) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(obj.body, { status: 200, headers });
};
