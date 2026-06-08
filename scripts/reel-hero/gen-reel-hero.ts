#!/usr/bin/env bun
// Generate 5 new scenes of the taxi-retriever via Luma image_edit.
// Reads LUMA_AGENTS_API_KEY from env. Never echoes it.

const KEY = process.env.LUMA_AGENTS_API_KEY;
if (!KEY) { console.error("missing LUMA_AGENTS_API_KEY"); process.exit(1); }

const MASTER = "https://truffleagent.com/i/lg_mq417avefcevh4xgwf660";
const OUT = "/home/phantom/repos/truffleagent-site/public/reel-hero";

const SCENES = [
  {
    file: "02.png",
    prompt: "The same golden retriever in oversized aviator sunglasses, now sitting on the worn stone steps of a Brooklyn brownstone, a takeaway coffee cup pinned between his front paws, morning sunlight catching the brass railing behind him. Photoreal cinematic look.",
  },
  {
    file: "03.png",
    prompt: "The same golden retriever in oversized aviator sunglasses, walking through Central Park at golden hour, copper and amber autumn leaves drifting around him, soft warm light on his fur, shallow depth of field. Photoreal cinematic look.",
  },
  {
    file: "04.png",
    prompt: "The same golden retriever in oversized aviator sunglasses, on a Manhattan rooftop at twilight, the city skyline glittering behind him, cool blue dusk light, a slight breeze ruffling his fur. Photoreal cinematic look.",
  },
  {
    file: "05.png",
    prompt: "The same golden retriever in oversized aviator sunglasses, standing on the yellow safety line of a New York subway platform, motion-blurred train lights streaking past, fluorescent platform glow on his coat. Photoreal cinematic look.",
  },
  {
    file: "06.png",
    prompt: "The same golden retriever in oversized aviator sunglasses, head out the window of a yellow taxi crossing the Brooklyn Bridge at sunset, wind ruffling his ears, warm orange skyline glow behind him. Photoreal cinematic look.",
  },
];

async function dispatch(prompt: string): Promise<string> {
  const r = await fetch("https://agents.lumalabs.ai/v1/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "image_edit",
      model: "uni-1",
      prompt,
      source: { url: MASTER },
      aspect_ratio: "1:1",
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`dispatch ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json() as { id: string };
  return j.id;
}

async function poll(id: string, deadlineMs: number): Promise<string> {
  while (Date.now() < deadlineMs) {
    const r = await fetch(`https://agents.lumalabs.ai/v1/generations/${id}`, {
      headers: { "Authorization": `Bearer ${KEY}` },
    });
    if (r.ok) {
      const j = await r.json() as { state: string; output?: { url?: string }; failure_reason?: string };
      if (j.state === "completed") {
        const u = j.output?.url;
        if (!u) throw new Error(`completed but no output.url for ${id}`);
        return u;
      }
      if (j.state === "failed") throw new Error(`failed: ${j.failure_reason ?? "unknown"}`);
    }
    await Bun.sleep(2000);
  }
  throw new Error(`timeout polling ${id}`);
}

async function download(url: string, outPath: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = await r.arrayBuffer();
  await Bun.write(outPath, buf);
}

async function main() {
  console.log(`master: ${MASTER}`);
  console.log(`first downloading master as 01.png`);
  await download(MASTER, `${OUT}/01.png`);
  console.log(`  -> 01.png OK`);

  console.log(`dispatching ${SCENES.length} scenes in parallel...`);
  const ids = await Promise.all(SCENES.map(async (s) => {
    const id = await dispatch(s.prompt);
    console.log(`  ${s.file} -> ${id}`);
    return { ...s, id };
  }));

  console.log(`initial 20s sleep before first poll`);
  await Bun.sleep(20000);

  const deadline = Date.now() + 4 * 60 * 1000;
  await Promise.all(ids.map(async (s) => {
    const url = await poll(s.id, deadline);
    console.log(`  ${s.file} completed -> ${url.slice(0, 60)}...`);
    await download(url, `${OUT}/${s.file}`);
    console.log(`  ${s.file} downloaded`);
  }));

  console.log(`all done`);
}

main().catch((e) => { console.error(e); process.exit(1); });
