// GET /v-cut/video/<piece>/v<version>/<shot>/<attempt>.mp4   (per-shot clip)
// GET /v-cut/final/<piece>/v<version>.mp4                    (assembled cut)
// R2 video proxy with HTTP Range support so <video> elements can seek.
// Double-bracket catch-all because R2 keys contain slashes. Keys are
// immutable once written, so cache hard.

import { type CutEnv, errorResponse } from "../_cut-shared.ts";

const KEY_RE =
  /^(video\/cu_[A-Za-z0-9]{1,22}\/v\d{1,2}\/s[1-9]\/\d{1,2}\.mp4|final\/cu_[A-Za-z0-9]{1,22}\/v\d{1,2}\.mp4)$/;

function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null | "invalid" {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (m[1] === "") {
    // suffix range: last N bytes
    const n = Math.min(Number(m[2]), size);
    if (n === 0) return "invalid";
    return { offset: size - n, length: n };
  }
  const start = Number(m[1]);
  if (start >= size) return "invalid";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

export const onRequestGet: PagesFunction<CutEnv> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/v-cut\//, ""));
  if (!KEY_RE.test(key)) return errorResponse(404, "not_found", "No such video.");

  const head = await ctx.env.CUT_BUCKET.head(key);
  if (!head) return errorResponse(404, "not_found", "No such video.");

  const baseHeaders: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: head.httpEtag,
  };

  const inm = ctx.request.headers.get("If-None-Match");
  if (inm && inm === head.httpEtag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const range = parseRange(ctx.request.headers.get("Range"), head.size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${head.size}` },
    });
  }

  if (range) {
    const obj = await ctx.env.CUT_BUCKET.get(key, {
      range: { offset: range.offset, length: range.length },
    });
    if (!obj || !obj.body) return errorResponse(404, "not_found", "No such video.");
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(range.length),
        "Content-Range": `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
      },
    });
  }

  const obj = await ctx.env.CUT_BUCKET.get(key);
  if (!obj || !obj.body) return errorResponse(404, "not_found", "No such video.");
  return new Response(obj.body, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(head.size) },
  });
};
