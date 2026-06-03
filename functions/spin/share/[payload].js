// GET /spin/share/<payload>/
// Returns a tiny HTML document whose only purpose is to give OG/Twitter
// crawlers a per-wheel preview card via og:image=/spin/og?w=<payload>,
// then redirect a human visitor to /spin/?w=<payload> so the live wheel
// loads. Crawlers don't execute JS but do read meta tags from the
// initial response; humans get a meta-refresh + JS replace fallback.
//
// Invalid or oversized payloads redirect to /spin/ instead of 4xx-ing,
// matching /spin/og's "always serve something usable" invariant.

const PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const MAX_PAYLOAD_LEN = 8192;

const CACHE_HEADERS = {
  "cache-control": "public, max-age=86400, s-maxage=86400",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function decodePayload(w) {
  if (!w || typeof w !== "string") return null;
  try {
    let b = w.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4 !== 0) b += "=";
    const bin = atob(b);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return null;
    if (!Array.isArray(obj.e)) return null;
    const name =
      typeof obj.n === "string" && obj.n.trim().length > 0
        ? obj.n.trim().slice(0, 64)
        : "Shared wheel";
    let count = 0;
    for (let i = 0; i < Math.min(obj.e.length, 200); i++) {
      const raw = obj.e[i];
      if (typeof raw !== "string") continue;
      const label = raw.trim();
      if (label.length === 0 || label.length > 80) continue;
      count++;
    }
    if (count === 0) return null;
    return { name, count };
  } catch {
    return null;
  }
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(s, max) {
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function redirectToSpin(request) {
  const url = new URL(request.url);
  return Response.redirect(new URL("/spin/", url.origin).toString(), 302);
}

function renderHtml({ playUrl, ogImageUrl, name, count }) {
  const friendlyName = name || "Shared spin wheel";
  const niceTitle = `${friendlyName} · truffleagent`;
  const description =
    count > 0
      ? `Spin the wheel with ${count} ${count === 1 ? "entry" : "entries"} — no ads, no signup.`
      : "Spin a custom decision wheel — no ads, no signup.";

  const safeTitle = xmlEscape(truncate(niceTitle, 120));
  const safeDesc = xmlEscape(truncate(description, 200));
  const safeOg = xmlEscape(ogImageUrl);
  const safePlay = xmlEscape(playUrl);
  // JSON.stringify produces a JS string literal safe for inline <script>
  // text; payload is also pre-validated against [A-Za-z0-9_-]+ so it
  // cannot contain </script> or other HTML-sensitive bytes.
  const jsPlay = JSON.stringify(playUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="truffleagent">
<meta property="og:url" content="${safePlay}">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDesc}">
<meta property="og:image" content="${safeOg}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:url" content="${safePlay}">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDesc}">
<meta name="twitter:image" content="${safeOg}">
<link rel="canonical" href="${safePlay}">
<meta http-equiv="refresh" content="0; url=${safePlay}">
<style>
:root { color-scheme: light dark; }
body { font-family: Inter, system-ui, -apple-system, sans-serif; background: #fbfaf5; color: #2a2622; margin: 0; padding: 48px 24px; max-width: 560px; margin-inline: auto; line-height: 1.55; }
@media (prefers-color-scheme: dark) { body { background: #1a1714; color: #ece6d4; } }
h1 { font-family: Georgia, 'Iowan Old Style', 'Times New Roman', serif; font-style: italic; font-weight: 500; font-size: 32px; margin: 0 0 12px; }
p { margin: 0 0 16px; }
a { color: #4850c4; text-decoration: underline; text-underline-offset: 2px; }
a:focus-visible { outline: 2px solid #4850c4; outline-offset: 3px; border-radius: 2px; }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
<p>Loading your wheel… <a href="${safePlay}">tap here if it doesn’t redirect</a>.</p>
<script>location.replace(${jsPlay});</script>
</body>
</html>`;
}

export async function onRequestGet({ params, request }) {
  const payload =
    typeof params.payload === "string" ? params.payload.trim() : "";

  if (
    payload.length === 0 ||
    payload.length > MAX_PAYLOAD_LEN ||
    !PAYLOAD_RE.test(payload)
  ) {
    return redirectToSpin(request);
  }

  const decoded = decodePayload(payload);
  const url = new URL(request.url);
  const playUrl = `${url.origin}/spin/?w=${payload}`;
  const ogImageUrl = `${url.origin}/spin/og?w=${payload}`;

  const html = renderHtml({
    playUrl,
    ogImageUrl,
    name: decoded ? decoded.name : "",
    count: decoded ? decoded.count : 0,
  });

  const headers = new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  for (const [k, v] of Object.entries(CACHE_HEADERS)) headers.set(k, v);

  return new Response(html, { status: 200, headers });
}

export async function onRequest({ params, request }) {
  const m = request.method;
  if (m !== "GET" && m !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  return onRequestGet({ params, request });
}
