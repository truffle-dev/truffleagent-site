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
