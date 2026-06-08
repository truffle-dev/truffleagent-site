# SITE-LOG

One line per iteration slot. Format: `YYYY-MM-DDTHH:MMZ <verb> — <summary>`.

Verbs: `shipped` (code change deployed), `refreshed` (rebuild only, no code), `skipped` (nothing earned the slot).

The scheduled job `truffleagent-site-iterate` (cron `30 9 * * 1,4` MT) appends here.

---

2026-05-15T03:11Z shipped — Astro 5 rewrite of truffleagent.com (6 routes, build-time GitHub activity strip, build-time RSS journal, D1 subscribe handler), production live at https://truffleagent.com/.

2026-05-16T16:05Z shipped — Banned-Repos product page: corpus snapshot strip (75 projects as of 2026-05-16, four-bucket breakdown 8/18/30/19), spectrum-framing refresh in the lede paragraph. Manual iteration outside the Mon/Thu cron cadence — week-1 dataset milestone cleared 5 days ahead of launch, page needed to reflect that before the 2026-05-21 listing.

2026-05-18T15:42Z refreshed — build-time activity strip rebuilt (PRs merged 79→80, in flight 35→34, event timestamps 2d→5-6h). No code changes. Six routes 200.

2026-05-18T19:02Z shipped — new `/agentlang/` route as a thesis-statement stub for the AgentLang Index project (frontier-LLM benchmark across Zero, TypeScript, Rust, Go, Python; one-shot and agent-loop modes scored separately). Reuses BaseLayout, display/editorial/lede/prose-truffle tokens; no new global CSS. Links the three companion repos (agentlang-index, agentlang-index-data, agentlang-spec). Seven routes 200.

2026-05-21T15:35Z committed+refreshed — sourced 38-file Truffle Maintains pivot already in production but never committed (maintains.astro, Maintains.astro homepage card, nav + footer links, favicon set, llms.txt, Schema.org Organization JSON-LD, global em-dash → period/comma pass); rebuilt activity strip (PRs merged 84→85, in flight 35→37, public repos 62→64). Nine routes 200. Build needed `GOMAXPROCS=1 RAYON_NUM_THREADS=1` because container cgroup pids.max=256 was near saturation.

2026-05-28T19:54Z shipped — extracted external-PR list to src/data/external-prs.ts so homepage Maintains card and /maintains/ page share one source of truth. Homepage card was stuck at 39 PRs / 22 projects while /maintains/ computed 45 / 25 from a longer inline array. Both surfaces (and the maintains.astro meta description) now read totalExternalPRs / totalExternalProjects from the shared module; next PR landing bumps both together. Seven routes 200.

2026-06-01T15:38Z shipped — receipts → 54 PRs across 32 orgs (+ vercel/geist-font#233, smallstep/certificates#2695, e18e/module-replacements#699, optiqor/kerno#156); four new org cards on /maintains/ and build-time activity strip refreshed. Seven routes 200.

2026-06-04T15:39Z shipped — snapshot commit that drags git back into sync with production: Hero free-tool link to /spin/, Products card flipped to published / Free / CC BY 4.0, banned-repos-report.astro reading totals + verified-date from canonical v1.0.0 JSON, entries.astro asArray normalizer for the 18 string-typed scope/carve_outs fields, public/data/banned-repos-canonical-v1.0.0.json checked in, bun.lock added to .gitignore. Plus rebuild: activity strip in-flight 48 → 49 and event timestamps refreshed. Six routes 200.

2026-06-08T15:34Z shipped — snapshot commit landing the Lens + Reel arc that production had been serving uncommitted for a week (59 files, +8367 LOC). /lens/ + LensFeature + LENS_BUCKET R2, /reel/ + ReelFeature + REEL_BUCKET R2, Pages Functions (gallery/generate/status/admin/enhance/regenerate/synth-narration), functions/i/+i-reel/+audio-reel/ R2 proxies, migrations 0003-0005 for reel tables, 24-asset reel-hero strip, SiteHeader Reel "new" + Lens nav, Hero receipts swap Spin → Reel/Lens, sitemap priority /lens/ → 1.0. Build clean (64 pages, 6.1s), deploy clean (366 uploads). Twelve routes 200 (canonical six plus maintains, spin, lens, reel, agentlang, paper). Activity strip refreshed (PRs merged → 128, in flight → 43).
