// GET /easel/render/<board>?token=<hmac> — read-only board render for the
// agent's screenshot_board tool. No JS, no chrome: just the board elements
// absolutely positioned inside a #stage div sized to their bounding box and
// scaled to fit a screenshot viewport. The playwright sibling navigates here,
// waits for load (which waits for the <img> tags), and screenshots #stage.
//
// Gated by the render token (HMAC of the board id keyed with
// EASEL_BRIDGE_TOKEN — see renderToken in _easel-shared.ts). The bridge mints
// the token per session; the route never appears in user-facing markup.

import type { EaselEnv } from "../../_easel-shared";
import { BOARD_ID_RE, errorResponse, renderToken } from "../../_easel-shared";
import type { EaselDoc, EaselElement } from "../../_easel-shared";

const PAD = 60;           // canvas units of padding around the bounding box
const MAX_EDGE = 1400;    // px cap on the scaled stage's long edge

const BG: Record<string, string> = {
  white: "#ffffff",
  paper: "#fdfbf7",
  dark: "#1a1a1a",
};

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// CSS color values are attacker-influencable strings (sticky/text color
// props). Allow only simple color syntax; anything else falls back.
function safeColor(v: unknown, fallback: string): string {
  const s = String(v ?? "");
  return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%deg]+\))$/.test(s)
    ? s
    : fallback;
}

function elementHtml(el: EaselElement): string {
  const rot = el.rotation ? `transform:rotate(${Number(el.rotation)}deg);` : "";
  const base = `left:${Number(el.x)}px;top:${Number(el.y)}px;width:${Number(el.w)}px;height:${Number(el.h)}px;z-index:${Number(el.z)};${rot}`;
  const p = el.props ?? {};
  switch (el.type) {
    case "image": {
      const src = typeof p.src === "string" && /^\/i-easel\/img\//.test(p.src) ? p.src : "";
      if (!src) return "";
      return `<div class="el el-image" style="${base}"><img src="${esc(src)}" alt=""></div>`;
    }
    case "text": {
      const size = Number(p.size) || 28;
      const weight = Number(p.weight) || 600;
      const color = safeColor(p.color, "#1a1a1a");
      const align = ["left", "center", "right"].includes(String(p.align)) ? String(p.align) : "left";
      return `<div class="el el-text" style="${base}font-size:${size}px;font-weight:${weight};color:${color};text-align:${align};">${esc(p.text)}</div>`;
    }
    case "sticky": {
      const color = safeColor(p.color, "#fff3a3");
      return `<div class="el el-sticky" style="${base}background:${color};">${esc(p.text)}</div>`;
    }
    case "frame":
      return `<div class="el el-frame" style="${base}"><span class="frame-label">${esc(p.label)}</span></div>`;
    default:
      return "";
  }
}

export const onRequestGet: PagesFunction<EaselEnv, "id"> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!BOARD_ID_RE.test(id)) return errorResponse(400, "bad_id", "malformed board id");

  const token = new URL(ctx.request.url).searchParams.get("token") ?? "";
  const expected = await renderToken(id, ctx.env.EASEL_BRIDGE_TOKEN);
  // Constant-time comparison; both sides are fixed-length hex.
  let mismatch = token.length === expected.length ? 0 : 1;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ (token.charCodeAt(i) || 0);
  }
  if (mismatch) return errorResponse(403, "forbidden", "bad render token");

  const row = await ctx.env.DB.prepare(
    `SELECT title, doc FROM easel_boards WHERE id = ?1`,
  ).bind(id).first<{ title: string; doc: string }>();
  if (!row) return errorResponse(404, "not_found", "no such board");

  const doc = JSON.parse(row.doc) as EaselDoc;
  const els = doc.elements ?? [];

  // Bounding box (with room for frame labels that hang above their frame).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of els) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y - (el.type === "frame" ? 28 : 0));
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  if (!els.length) { minX = 0; minY = 0; maxX = 800; maxY = 500; }
  const stageW = maxX - minX + PAD * 2;
  const stageH = maxY - minY + PAD * 2;
  const scale = Math.min(1, MAX_EDGE / stageW, MAX_EDGE / stageH);
  const outW = Math.ceil(stageW * scale);
  const outH = Math.ceil(stageH * scale);

  const body = els
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((el) => elementHtml({ ...el, x: el.x - minX + PAD, y: el.y - minY + PAD }))
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>${esc(row.title)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    width: ${outW}px; height: ${outH}px; overflow: hidden;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  #stage {
    position: relative;
    width: ${stageW}px; height: ${stageH}px;
    transform: scale(${scale}); transform-origin: top left;
    background: ${BG[doc.background] ?? BG.white};
  }
  .el { position: absolute; box-sizing: border-box; }
  .el-image img {
    width: 100%; height: 100%; object-fit: cover; display: block;
    border-radius: 6px; box-shadow: 0 1px 6px rgba(0,0,0,0.14);
  }
  .el-text { line-height: 1.25; padding: 4px 6px; white-space: pre-wrap; word-break: break-word; overflow: hidden; }
  .el-sticky {
    border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    padding: 12px; font-size: 15px; line-height: 1.4;
    white-space: pre-wrap; word-break: break-word; overflow: hidden;
  }
  .el-frame { border: 1.5px solid rgba(0,0,0,0.35); border-radius: 12px; background: rgba(255,255,255,0.35); }
  .frame-label {
    position: absolute; top: -1.6em; left: 0;
    font-size: 13px; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; opacity: 0.7; white-space: nowrap;
  }
</style>
</head><body><div id="stage">
${body}
</div></body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};
