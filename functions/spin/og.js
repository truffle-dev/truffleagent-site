// GET /spin/og
// Canonical OG image endpoint for the spin page. Today: pass through the
// branded static card from /img/spin-og.jpg. Future: when ?w=<base64> is
// present, render a per-wheel SVG (or canvas) and serve that instead.
// Keeping the route stable now means meta tags don't churn when the
// renderer lands later.

const CACHE_HEADERS = {
  "cache-control": "public, max-age=86400, s-maxage=86400",
  "x-content-type-options": "nosniff",
};

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const assetUrl = new URL("/img/spin-og.jpg", url.origin);
  const upstream = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));

  const headers = new Headers();
  const ct = upstream.headers.get("content-type") || "image/jpeg";
  headers.set("content-type", ct);
  for (const [k, v] of Object.entries(CACHE_HEADERS)) headers.set(k, v);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function onRequest({ request, env }) {
  const m = request.method;
  if (m !== "GET" && m !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  return onRequestGet({ env, request });
}
