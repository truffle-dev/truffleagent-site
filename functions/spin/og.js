// GET /spin/og
// Canonical OG image endpoint for the spin page.
// Default (no ?w): pass through the branded static card from
// /img/spin-og.jpg as image/jpeg.
// With ?w=<urlsafe-base64-utf8-json>: render a per-wheel SVG card
// (1200x630) showing the wheel name, an entry preview, and a small
// wheel illustration using the matching slice colors. The encoding
// mirrors the share-link contract in src/pages/spin/index.astro:
// {n: name, e: entries[], c?: colors[], w?: weights[]}.
// Falls back to the static card when ?w is invalid.

const CACHE_HEADERS = {
  "cache-control": "public, max-age=86400, s-maxage=86400",
  "x-content-type-options": "nosniff",
};

// Warm-paper palette tokens, mirrored from src/pages/spin/index.astro
// (PALETTES.paper). Used when the share payload omits per-entry
// colors (the `c?` field). Renderer cycles through these in order.
const PAPER_PALETTE = [
  "#4850c4",
  "#6a7d3b",
  "#b07d2a",
  "#a14a2a",
  "#3b3527",
  "#84785a",
  "#5d68d0",
  "#3b41a3",
];

const BG = "#fbfaf5";
const INK = "#2a2622";
const INK_MUTED = "#6b6358";
const INDIGO = "#4850c4";
const PAPER_300 = "#e3dccb";

const MAX_TITLE_CHARS = 26;
const MAX_ENTRY_CHARS = 32;
const MAX_ENTRIES_SHOWN = 6;

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
    const entries = [];
    const rawColors = Array.isArray(obj.c) ? obj.c : [];
    const rawWeights = Array.isArray(obj.w) ? obj.w : [];
    for (let i = 0; i < Math.min(obj.e.length, 200); i++) {
      const raw = obj.e[i];
      if (typeof raw !== "string") continue;
      const label = raw.trim();
      if (label.length === 0 || label.length > 80) continue;
      const rc = rawColors[i];
      const color =
        typeof rc === "string" && /^#[0-9a-fA-F]{6}$/.test(rc)
          ? rc.toLowerCase()
          : null;
      const rw = rawWeights[i];
      let weight = 1;
      if (typeof rw === "number" && Number.isFinite(rw)) {
        weight = Math.max(1, Math.min(10, Math.round(rw)));
      }
      entries.push({ label, color, weight });
    }
    if (entries.length === 0) return null;
    return { name, entries };
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
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function buildWheelPath(cx, cy, r, startAngle, endAngle) {
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return (
    `M ${cx.toFixed(2)} ${cy.toFixed(2)} ` +
    `L ${x1.toFixed(2)} ${y1.toFixed(2)} ` +
    `A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`
  );
}

function renderWheelIllustration(cx, cy, r, entries) {
  const totalWeight = entries.reduce((s, e) => s + (e.weight || 1), 0) || 1;
  let acc = 0;
  const slices = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const w = e.weight || 1;
    const startAngle = -Math.PI / 2 + (acc / totalWeight) * Math.PI * 2;
    acc += w;
    const endAngle = -Math.PI / 2 + (acc / totalWeight) * Math.PI * 2;
    const fill = e.color || PAPER_PALETTE[i % PAPER_PALETTE.length];
    if (entries.length === 1) {
      slices.push(
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" />`
      );
    } else {
      const d = buildWheelPath(cx, cy, r, startAngle, endAngle);
      slices.push(`<path d="${d}" fill="${fill}" />`);
    }
  }
  const pointerTopY = cy - r - 8;
  const pointerH = 26;
  const pointer = `<path d="M ${cx - 14} ${pointerTopY} L ${cx + 14} ${pointerTopY} L ${cx} ${
    pointerTopY + pointerH
  } Z" fill="${INK}" />`;
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK}" stroke-width="2" opacity="0.18" />`;
  const hub = `<circle cx="${cx}" cy="${cy}" r="${(r * 0.16).toFixed(1)}" fill="${BG}" stroke="${INK}" stroke-width="1.5" opacity="0.85" />`;
  return slices.join("") + ring + hub + pointer;
}

function renderSvg({ name, entries }) {
  const safeName = xmlEscape(truncate(name, MAX_TITLE_CHARS));
  const entryCount = entries.length;
  const shown = entries.slice(0, MAX_ENTRIES_SHOWN);
  const overflow = entryCount - shown.length;
  const countLabel =
    entryCount === 1 ? "1 entry" : `${entryCount} entries`;

  const entryLines = shown
    .map((e, i) => {
      const y = 330 + i * 42;
      const label = xmlEscape(truncate(e.label, MAX_ENTRY_CHARS));
      return `<text x="80" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="${INK}"><tspan fill="${INK_MUTED}">${i + 1}.</tspan> ${label}</text>`;
    })
    .join("");

  const overflowLine =
    overflow > 0
      ? `<text x="80" y="${330 + shown.length * 42}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="${INDIGO}">+ ${overflow} more</text>`
      : "";

  const wheel = renderWheelIllustration(960, 315, 200, entries);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Spin wheel: ${safeName}">
  <rect width="1200" height="630" fill="${BG}" />
  <rect x="0" y="624" width="1200" height="6" fill="${PAPER_300}" />
  <text x="80" y="116" font-family="Helvetica, Arial, sans-serif" font-size="18" letter-spacing="3" fill="${INK_MUTED}">SPIN</text>
  <text x="80" y="222" font-family="Georgia, 'Iowan Old Style', 'Times New Roman', serif" font-style="italic" font-size="64" fill="${INK}">${safeName}</text>
  <text x="80" y="270" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="${INK_MUTED}">${countLabel}</text>
  ${entryLines}
  ${overflowLine}
  ${wheel}
  <text x="1120" y="592" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="${INK_MUTED}" text-anchor="end">truffleagent.com/spin</text>
</svg>`;
}

async function servePerWheelSvg(wParam) {
  const payload = decodePayload(wParam);
  if (!payload) return null;
  const svg = renderSvg(payload);
  const headers = new Headers();
  headers.set("content-type", "image/svg+xml; charset=utf-8");
  for (const [k, v] of Object.entries(CACHE_HEADERS)) headers.set(k, v);
  return new Response(svg, { status: 200, headers });
}

async function serveStaticCard(env, request) {
  const url = new URL(request.url);
  const assetUrl = new URL("/img/spin-og.jpg", url.origin);
  const upstream = await env.ASSETS.fetch(
    new Request(assetUrl, { method: "GET" })
  );
  const headers = new Headers();
  const ct = upstream.headers.get("content-type") || "image/jpeg";
  headers.set("content-type", ct);
  for (const [k, v] of Object.entries(CACHE_HEADERS)) headers.set(k, v);
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const w = url.searchParams.get("w");
  if (w) {
    const svgRes = await servePerWheelSvg(w);
    if (svgRes) return svgRes;
  }
  return serveStaticCard(env, request);
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
