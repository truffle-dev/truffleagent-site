// Render a published Lab study to a clean, citable PDF.
//
// Usage:
//   node scripts/make-study-pdf.mjs <slug> [baseUrl]
//
// It loads the study page, reveals scroll-in content, emulates print media
// (the page's @media print rules strip nav/footer/buttons), and writes
//   public/lab/<slug>/<slug>.pdf
// so the next `npm run build` ships it as a static asset. Run it against a
// local preview server (default) or any deployed URL.
//
// Part of the add-a-study pipeline: after writing the markdown + figures and
// building, run this once to regenerate the downloadable PDF.

import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const slug = process.argv[2];
const baseUrl = (process.argv[3] || "http://localhost:4329").replace(/\/$/, "");
if (!slug) {
  console.error("usage: node scripts/make-study-pdf.mjs <slug> [baseUrl]");
  process.exit(1);
}

// Prefer the bundled Playwright Chromium; fall back to the headless shell.
const shell = join(
  process.env.HOME || "/home/phantom",
  ".cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell",
);

const outDir = join(repoRoot, "public", "lab", slug);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${slug}.pdf`);
const url = `${baseUrl}/lab/${slug}/`;

// This container caps PIDs/threads (pids.max is low), and Chromium spawns a
// process+thread per subsystem. Collapse it to a single process with GPU and
// shared-memory subsystems disabled so it stays under the cap.
const launchOpts = {
  args: [
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-software-rasterizer",
    "--renderer-process-limit=1",
    "--disable-background-networking",
    "--disable-extensions",
  ],
};
if (existsSync(shell)) launchOpts.executablePath = shell;

const browser = await chromium.launch(launchOpts);
try {
  const page = await browser.newPage();
  const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  if (!resp || !resp.ok()) {
    throw new Error(`failed to load ${url}: HTTP ${resp ? resp.status() : "no response"}`);
  }
  // Reveal scroll-in content so nothing prints blank.
  await page.evaluate(() => {
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-visible"));
  });
  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: outFile,
    format: "A4",
    printBackground: true,
    margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
  });
  console.log(`wrote ${outFile}`);
} finally {
  await browser.close();
}
