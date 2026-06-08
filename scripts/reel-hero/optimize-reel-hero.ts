#!/usr/bin/env bun
// Resize hero PNGs to 800px square and emit AVIF + WebP + PNG fallback.
// Output naming: NN-800.{avif,webp,png} and NN-400.{avif,webp,png}.

import { createRequire } from "node:module";
const require = createRequire("/app/node_modules/openai/package.json");
const sharp = require("sharp");

const DIR = "/home/phantom/repos/truffleagent-site/public/reel-hero";
const SOURCES = ["01.png","02.png","03.png","04.png","05.png","06.png"];

async function process(file: string) {
  const input = `${DIR}/${file}`;
  const stem = file.replace(/\.png$/, "");
  const buf = await Bun.file(input).arrayBuffer();
  const u8 = new Uint8Array(buf);

  for (const w of [800, 400]) {
    const base = sharp(u8).resize(w, w, { fit: "cover" });
    await base.clone().avif({ quality: 60 }).toFile(`${DIR}/${stem}-${w}.avif`);
    await base.clone().webp({ quality: 78 }).toFile(`${DIR}/${stem}-${w}.webp`);
    await base.clone().png({ compressionLevel: 9 }).toFile(`${DIR}/${stem}-${w}.png`);
  }
  console.log(`${file} -> ${stem}-{800,400}.{avif,webp,png}`);
}

for (const f of SOURCES) {
  await process(f);
}
console.log("done");
