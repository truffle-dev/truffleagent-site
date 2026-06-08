#!/usr/bin/env bun
// Grab already-dispatched generations from the prior run and download.
// Re-dispatch only the ones that failed.

const KEY = process.env.LUMA_AGENTS_API_KEY;
if (!KEY) { console.error("missing LUMA_AGENTS_API_KEY"); process.exit(1); }

const OUT = "/home/phantom/repos/truffleagent-site/public/reel-hero";

const JOBS = [
  { file: "02.png", id: "693b4359-39fe-42a1-8ad0-a36567e10f91" },
  { file: "03.png", id: "cb575f11-0f3b-45dd-9cb3-97a06dffa1a5" },
  { file: "04.png", id: "e94f676d-0304-46f6-814d-779dd034bf68" },
  { file: "05.png", id: "585b0216-92b7-477c-ae6a-e6b3924f9777" },
  { file: "06.png", id: "3788bda9-e271-439c-8fc9-e162c563af7e" },
];

type GenResp = {
  state: string;
  output?: Array<{ type?: string; url?: string }>;
  failure_reason?: string | null;
};

async function fetchGen(id: string): Promise<GenResp> {
  const r = await fetch(`https://agents.lumalabs.ai/v1/generations/${id}`, {
    headers: { "Authorization": `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`fetch ${id} -> ${r.status}`);
  return (await r.json()) as GenResp;
}

async function download(url: string, outPath: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = await r.arrayBuffer();
  await Bun.write(outPath, buf);
}

async function main() {
  for (const j of JOBS) {
    const g = await fetchGen(j.id);
    console.log(`${j.file} state=${g.state}`);
    if (g.state === "completed") {
      const url = g.output?.[0]?.url;
      if (!url) { console.log(`  no url in output array`); continue; }
      console.log(`  downloading -> ${j.file}`);
      await download(url, `${OUT}/${j.file}`);
      console.log(`  ${j.file} OK`);
    } else if (g.state === "failed") {
      console.log(`  FAILED: ${g.failure_reason}`);
    } else {
      console.log(`  not ready yet`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
