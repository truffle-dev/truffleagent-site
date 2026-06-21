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

// Conditional text styling for sticky/shape labels — only emit a property when
// the prop is present so each element's CSS default holds (zero regression).
function textStyle(p: Record<string, unknown>): string {
  let s = "";
  const size = Number(p.size);
  if (size > 0) s += `font-size:${size}px;`;
  const weight = Number(p.weight);
  if (weight > 0) s += `font-weight:${weight};`;
  if (typeof p.textColor === "string" && p.textColor) s += `color:${safeColor(p.textColor, "#1a1a1a")};`;
  return s;
}

// Text alignment, mirroring the canvas applyTextStyle. Returns "" for the
// default so sticky (block, left) and shape (flex, centre) keep their CSS
// defaults; a valid prop overrides both text-align and (for the flex shape)
// justify-content.
function alignValue(p: Record<string, unknown>): string {
  return ["left", "center", "right"].includes(String(p.align)) ? String(p.align) : "";
}
function justifyFor(align: string): string {
  return align === "left" ? "flex-start" : align === "right" ? "flex-end" : align === "center" ? "center" : "";
}

function elementHtml(el: EaselElement): string {
  const rot = el.rotation ? `transform:rotate(${Number(el.rotation)}deg);` : "";
  // Element opacity (props.opacity, 0.1..1). Mirrors the canvas renderEl and the
  // agent's update_elements props.opacity; full opacity emits nothing.
  const opNum = Number((el.props ?? {}).opacity);
  const op = Number.isFinite(opNum) && opNum < 1 ? `opacity:${Math.max(0.1, Math.min(1, opNum))};` : "";
  const base = `left:${Number(el.x)}px;top:${Number(el.y)}px;width:${Number(el.w)}px;height:${Number(el.h)}px;z-index:${Number(el.z)};${rot}${op}`;
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
      const color = safeColor(p.textColor ?? p.color, "#1a1a1a");
      const align = ["left", "center", "right"].includes(String(p.align)) ? String(p.align) : "left";
      return `<div class="el el-text" style="${base}font-size:${size}px;font-weight:${weight};color:${color};text-align:${align};">${esc(p.text)}</div>`;
    }
    case "sticky": {
      const isSuggestion = !!p.suggestion;
      const color = safeColor(p.color, isSuggestion ? "#eef1ff" : "#fff3a3");
      const sa = alignValue(p);
      const stickyAlign = sa ? `text-align:${sa};` : "";
      if (isSuggestion) {
        // Agent-left advisory note. The render route is read-only (no dismiss ×),
        // but the dashed frame + badge must match the canvas so screenshot_board
        // vision reads it as a suggestion, not a plain note.
        return `<div class="el el-sticky el-suggestion" style="${base}background:${color};${textStyle(p)}${stickyAlign}"><span class="suggest-badge">Suggestion</span>${esc(p.text)}</div>`;
      }
      return `<div class="el el-sticky" style="${base}background:${color};${textStyle(p)}${stickyAlign}">${esc(p.text)}</div>`;
    }
    case "frame":
      return `<div class="el el-frame" style="${base}"><span class="frame-label">${esc(p.label)}</span></div>`;
    case "shape": {
      const fill = safeColor(p.fill, "#bcdcff");
      const stroke = safeColor(p.stroke, "#3a4a8c");
      // diamond/triangle render as a non-scaling-stroke polygon behind the
      // label (mirrors the canvas) so screenshot_board vision reads the shape,
      // not a box. rect/ellipse stay box-styled.
      const poly = p.kind === "diamond" ? "50,2 98,50 50,98 2,50"
        : p.kind === "triangle" ? "50,4 96,96 4,96" : "";
      // Shape is a centred flex box: a non-default align maps to both
      // justify-content (the container) and text-align (the label).
      const sa = alignValue(p);
      const shapeJustify = sa ? `justify-content:${justifyFor(sa)};` : "";
      const shapeAlign = sa ? `text-align:${sa};` : "";
      if (poly) {
        return `<div class="el el-shape" style="${base}${shapeJustify}">`
          + `<svg class="shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;z-index:0;overflow:visible;">`
          + `<polygon points="${poly}" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`
          + `<span class="shape-label" style="position:relative;z-index:1;${textStyle(p)}${shapeAlign}">${esc(p.text)}</span></div>`;
      }
      const radius = p.kind === "ellipse" ? "50%" : "10px";
      return `<div class="el el-shape" style="${base}background:${fill};border:2px solid ${stroke};border-radius:${radius};${textStyle(p)}${shapeJustify}${shapeAlign}">${esc(p.text)}</div>`;
    }
    case "draw": {
      // Freehand polyline. The viewBox is the stroke's drawn box (vbW/vbH,
      // defaulting to w/h); preserveAspectRatio=none stretches it to the node.
      const pts = Array.isArray(p.points) ? (p.points as unknown[]) : [];
      const coords: string[] = [];
      for (const pt of pts) {
        if (!Array.isArray(pt)) continue;
        const x = Number(pt[0]), y = Number(pt[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) coords.push(`${x} ${y}`);
      }
      if (coords.length < 2) return "";
      const vbW = Number(p.vbW) > 0 ? Number(p.vbW) : (Number(el.w) || 1);
      const vbH = Number(p.vbH) > 0 ? Number(p.vbH) : (Number(el.h) || 1);
      const stroke = safeColor(p.stroke, "#1f1d1a");
      const width = Number(p.width) > 0 ? Number(p.width) : 3;
      const d = "M" + coords.join(" L");
      return `<div class="el el-draw" style="${base}"><svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none" style="width:100%;height:100%;overflow:visible;display:block;"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"></path></svg></div>`;
    }
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
  // Connectors are excluded: their geometry is derived from the elements they
  // join (placeholder x/y/w/h of 0 would otherwise drag the box to the origin).
  const boxEls = els.filter((el) => el.type !== "connector");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of boxEls) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y - (el.type === "frame" ? 28 : 0));
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  if (!boxEls.length) { minX = 0; minY = 0; maxX = 800; maxY = 500; }
  const stageW = maxX - minX + PAD * 2;
  const stageH = maxY - minY + PAD * 2;
  const scale = Math.min(1, MAX_EDGE / stageW, MAX_EDGE / stageH);
  const outW = Math.ceil(stageW * scale);
  const outH = Math.ceil(stageH * scale);

  // Shifted box geometry by id, for resolving connector endpoints below.
  const boxById = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const el of boxEls) {
    boxById.set(el.id, { x: el.x - minX + PAD, y: el.y - minY + PAD, w: el.w, h: el.h });
  }

  const body = boxEls
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((el) => elementHtml({ ...el, x: el.x - minX + PAD, y: el.y - minY + PAD }))
    .join("\n");

  // Connector overlay: a single SVG at the back of the stage with one line per
  // connector whose endpoints both resolve. Endpoints are clipped to each box's
  // border along the centre-to-centre line so the arrow touches the edge, not
  // the middle. Drawn behind the elements (z-index 0); pointer-events: none.
  const borderPt = (b: { x: number; y: number; w: number; h: number }, tx: number, ty: number) => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const s = 1 / Math.max(Math.abs(dx) / (b.w / 2), Math.abs(dy) / (b.h / 2));
    return { x: cx + dx * s, y: cy + dy * s };
  };
  // Mirror of the canvas connPathD: straight segment, dominant-axis cubic bezier
  // ("curved"), or orthogonal two-bend path ("elbow"). Keeps the agent's
  // screenshot_board vision byte-identical to what a human sees on the canvas.
  const connPathD = (sx: number, sy: number, ex: number, ey: number, routing: string): string => {
    const x1 = sx.toFixed(1), y1 = sy.toFixed(1), x2 = ex.toFixed(1), y2 = ey.toFixed(1);
    const dx = ex - sx, dy = ey - sy;
    if (routing === "curved") {
      if (Math.abs(dx) >= Math.abs(dy)) {
        return `M${x1} ${y1} C${(sx + dx * 0.5).toFixed(1)} ${y1} ${(ex - dx * 0.5).toFixed(1)} ${y2} ${x2} ${y2}`;
      }
      return `M${x1} ${y1} C${x1} ${(sy + dy * 0.5).toFixed(1)} ${x2} ${(ey - dy * 0.5).toFixed(1)} ${x2} ${y2}`;
    }
    if (routing === "elbow") {
      if (Math.abs(dx) >= Math.abs(dy)) {
        const mx = ((sx + ex) / 2).toFixed(1);
        return `M${x1} ${y1} L${mx} ${y1} L${mx} ${y2} L${x2} ${y2}`;
      }
      const my = ((sy + ey) / 2).toFixed(1);
      return `M${x1} ${y1} L${x1} ${my} L${x2} ${my} L${x2} ${y2}`;
    }
    return `M${x1} ${y1} L${x2} ${y2}`;
  };
  const lineParts: string[] = [];
  const labelParts: string[] = [];
  for (const el of els) {
    if (el.type !== "connector") continue;
    const p = el.props ?? {};
    const a = boxById.get(String(p.from));
    const b = boxById.get(String(p.to));
    if (!a || !b) continue;
    const s = borderPt(a, b.x + b.w / 2, b.y + b.h / 2);
    const e = borderPt(b, a.x + a.w / 2, a.y + a.h / 2);
    const color = safeColor(p.color, "#5b6472");
    const marker = p.style === "line" ? "" : ` marker-end="url(#arrow)"`;
    const d = connPathD(s.x, s.y, e.x, e.y, String(p.routing || "straight"));
    lineParts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"${marker} />`);
    // Midpoint label (props.label) painted as an HTML pill above the line so the
    // agent's screenshot_board vision reads the arrow text the same as a human.
    const label = typeof p.label === "string" ? p.label.trim() : "";
    if (label) {
      const mx = ((s.x + e.x) / 2).toFixed(1);
      const my = ((s.y + e.y) / 2).toFixed(1);
      labelParts.push(`<div class="conn-label" style="left:${mx}px;top:${my}px;">${esc(label)}</div>`);
    }
  }
  const lines = lineParts.join("\n");
  const connectorsSvg = lines
    ? `<svg width="${stageW}" height="${stageH}" style="position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:0;"><defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,4.5 L0,9 z" fill="context-stroke"></path></marker></defs>${lines}</svg>`
    : "";
  const connLabels = labelParts.join("\n");

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
    position: relative;
  }
  /* CSS-only broken-image fallback. This render is screenshotted by the agent
     and embedded in a script-less sandboxed iframe on the gallery, so there is
     no JS onerror to lean on. Pseudo-elements on an <img> are painted only when
     the image fails to load, so a since-deleted source degrades to a paper
     placeholder instead of the browser's broken-image glyph. */
  .el-image img::before {
    content: ""; position: absolute; inset: 0;
    background: #fdfbf7; border: 1.5px dashed rgba(0,0,0,0.22); border-radius: 6px;
  }
  .el-image img::after {
    content: "image unavailable"; position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: rgba(0,0,0,0.45); font-size: 13px;
  }
  .el-text { line-height: 1.25; padding: 4px 6px; white-space: pre-wrap; word-break: break-word; overflow: hidden; }
  .el-sticky {
    border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    padding: 12px; font-size: 15px; line-height: 1.4;
    white-space: pre-wrap; word-break: break-word; overflow: hidden;
  }
  .el-suggestion { border: 1.5px dashed #5b6bf5; padding-top: 26px; box-shadow: 0 2px 10px rgba(91,107,245,0.22); }
  .suggest-badge {
    position: absolute; top: 6px; left: 8px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: #fff; background: #5b6bf5; padding: 2px 7px; border-radius: 999px;
  }
  .el-frame { border: 1.5px solid rgba(0,0,0,0.35); border-radius: 12px; background: rgba(255,255,255,0.35); }
  .el-shape {
    display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 10px;
    font-size: 15px; line-height: 1.35; font-weight: 600; color: #1a1a1a;
    white-space: pre-wrap; word-break: break-word; overflow: hidden;
  }
  .frame-label {
    position: absolute; top: -1.6em; left: 0;
    font-size: 13px; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; opacity: 0.7; white-space: nowrap;
  }
  .conn-label {
    position: absolute; transform: translate(-50%, -50%);
    max-width: 220px; padding: 2px 8px; border-radius: 7px;
    background: #ffffff; border: 1px solid rgba(0,0,0,0.12);
    box-shadow: 0 1px 4px rgba(0,0,0,0.12);
    font-size: 12.5px; line-height: 1.3; color: #2a2f3a;
    text-align: center; white-space: pre-wrap; word-break: break-word;
    z-index: 50;
  }
</style>
</head><body><div id="stage">
${connectorsSvg}
${body}
${connLabels}
</div></body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};
