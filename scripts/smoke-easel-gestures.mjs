#!/usr/bin/env node
// scripts/smoke-easel-gestures.mjs [base_url]
//
// Gesture-invariant regression guard for the Easel canvas. The HTTP-only
// smoke-easel.sh exercises the board API but never touches the pointer/wheel
// handlers, so a multi-select or draw-tool change that steals plain-drag pan
// or forces every wheel to zoom (the P5.1 regression class) sails through it
// green. This drives a real Chromium against the six protected gestures and
// asserts the #world transform moves the way the navigation contract promises.
//
// The contract, read straight off the handlers in src/pages/easel/index.astro:
//   - plain left-drag on empty canvas PANS               (transform translate changes, scale same)
//   - plain wheel / two-finger scroll PANS                (translate changes, scale same)
//   - ctrl/cmd + wheel ZOOMS around the cursor            (scale changes)
//   - shift + wheel pans HORIZONTALLY                     (panX changes)
//   - shift + left-drag is MARQUEE select, not pan        (transform unchanged)
//   - space + left-drag PANS                              (translate changes, scale same)
//
// Done-criterion: runs green against prod and gates scripts/deploy-easel.sh.
//
// Usage: node scripts/smoke-easel-gestures.mjs [https://truffleagent.com]

import { createRequire } from "node:module";
const require = createRequire("/app/node_modules/");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "https://truffleagent.com";
const EPS = 2; // px / scale epsilon: below this is "unchanged"

let PASS = 0, FAIL = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  ok   ${name}`); PASS++; }
  else { console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); FAIL++; }
}

// Parse `translate(123px, 45px) scale(1.1)` -> {panX, panY, zoom}.
function parseView(transform) {
  const t = /translate\(\s*(-?[\d.]+)px[, ]+\s*(-?[\d.]+)px\s*\)/.exec(transform || "");
  const s = /scale\(\s*(-?[\d.]+)\s*\)/.exec(transform || "");
  return {
    panX: t ? parseFloat(t[1]) : 0,
    panY: t ? parseFloat(t[2]) : 0,
    zoom: s ? parseFloat(s[1]) : 1,
  };
}

async function main() {
  console.log(`Easel gesture smoke against ${BASE}`);

  // 1. Throwaway board via the same API the smoke script uses.
  const create = await fetch(`${BASE}/api/easel/board`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const cj = await create.json().catch(() => ({}));
  const board = cj && typeof cj.id === "string" ? cj.id : "";
  check("POST /api/easel/board -> id", /^el_[a-z0-9]{8,22}$/.test(board), board || "(none)");
  if (!board) { console.log("\nno board id; aborting"); process.exit(1); }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(`${BASE}/easel/?b=${board}`, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Canvas ready = openBoard hid the hero. Then #stage/#world are live.
    await page.waitForFunction(() => {
      const h = document.getElementById("easel-hero");
      return h && h.hidden === true;
    }, { timeout: 20000 });
    await page.waitForSelector("#world", { state: "attached", timeout: 5000 });

    const readView = async () =>
      parseView(await page.$eval("#world", (el) => el.style.transform));

    // Pick an empty point well inside the stage, clear of any toolbar/dock.
    const box = await page.$eval("#stage", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const cx = Math.round(box.x + box.w * 0.55);
    const cy = Math.round(box.y + box.h * 0.5);

    // --- Gesture 1: plain left-drag PANS ---
    {
      const before = await readView();
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 150, cy + 100, { steps: 8 });
      await page.mouse.up();
      const after = await readView();
      const dx = after.panX - before.panX, dy = after.panY - before.panY;
      const panned = Math.abs(dx) > 20 && Math.abs(dy) > 20;
      const zoomSame = Math.abs(after.zoom - before.zoom) < EPS;
      check("plain left-drag pans (translate moves, scale fixed)", panned && zoomSame,
        `dpan=(${dx.toFixed(0)},${dy.toFixed(0)}) dzoom=${(after.zoom - before.zoom).toFixed(3)}`);
    }

    // --- Gesture 2: plain wheel PANS (not zoom) ---
    {
      const before = await readView();
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, 120);
      const after = await readView();
      const moved = Math.abs(after.panY - before.panY) > 20;
      const zoomSame = Math.abs(after.zoom - before.zoom) < EPS;
      check("plain wheel pans (scale fixed)", moved && zoomSame,
        `dpanY=${(after.panY - before.panY).toFixed(0)} dzoom=${(after.zoom - before.zoom).toFixed(3)}`);
    }

    // --- Gesture 3: ctrl + wheel ZOOMS ---
    {
      const before = await readView();
      await page.mouse.move(cx, cy);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -120); // up = zoom in
      await page.keyboard.up("Control");
      const after = await readView();
      const zoomed = Math.abs(after.zoom - before.zoom) > 0.02;
      check("ctrl+wheel zooms (scale changes)", zoomed,
        `dzoom=${(after.zoom - before.zoom).toFixed(3)}`);
    }

    // --- Gesture 4: shift + wheel pans HORIZONTALLY ---
    {
      const before = await readView();
      await page.mouse.move(cx, cy);
      await page.keyboard.down("Shift");
      await page.mouse.wheel(0, 120);
      await page.keyboard.up("Shift");
      const after = await readView();
      const movedX = Math.abs(after.panX - before.panX) > 20;
      const zoomSame = Math.abs(after.zoom - before.zoom) < EPS;
      check("shift+wheel pans horizontally (scale fixed)", movedX && zoomSame,
        `dpanX=${(after.panX - before.panX).toFixed(0)} dzoom=${(after.zoom - before.zoom).toFixed(3)}`);
    }

    // --- Gesture 5: shift + left-drag is MARQUEE, not pan ---
    {
      const before = await readView();
      await page.keyboard.down("Shift");
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 140, cy + 90, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up("Shift");
      const after = await readView();
      const unchanged =
        Math.abs(after.panX - before.panX) < EPS &&
        Math.abs(after.panY - before.panY) < EPS &&
        Math.abs(after.zoom - before.zoom) < EPS;
      check("shift+drag marquees (transform unchanged)", unchanged,
        `dpan=(${(after.panX - before.panX).toFixed(0)},${(after.panY - before.panY).toFixed(0)})`);
    }

    // --- Gesture 6: space + left-drag PANS ---
    {
      const before = await readView();
      await page.mouse.move(cx, cy);
      await page.keyboard.down("Space");
      await page.mouse.down();
      await page.mouse.move(cx - 120, cy - 80, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      const after = await readView();
      const dx = after.panX - before.panX, dy = after.panY - before.panY;
      const panned = Math.abs(dx) > 20 && Math.abs(dy) > 20;
      const zoomSame = Math.abs(after.zoom - before.zoom) < EPS;
      check("space+drag pans (translate moves, scale fixed)", panned && zoomSame,
        `dpan=(${dx.toFixed(0)},${dy.toFixed(0)}) dzoom=${(after.zoom - before.zoom).toFixed(3)}`);
    }
  } finally {
    await browser.close();
  }

  console.log("");
  console.log(`gesture smoke: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n!! gesture smoke crashed:", err && err.message ? err.message : err);
  process.exit(1);
});
