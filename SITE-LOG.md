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

2026-06-11T15:35Z shipped — homepage copy-freshness pass: hero receipts swapped Reel/Lens for Cut ("one prompt, a whole edit") and Take ("text to video, critic in the loop"); resolved duplicate "Premier · just shipped" eyebrow (Take → "Video · critic in the loop", only Cut keeps Premier); Lens eyebrow aligned to category-first pattern ("Images · public gallery"). Note: glyph registry sync (b517169) deployed earlier today, so activity strip was already fresh. Twelve routes 200, zero console errors, zero failed requests.

2026-06-18T16:04Z shipped — activity strip: monotonic floor on merged-PR count. GitHub is:merged search total_count had deflated to 77 (vs 141 genuinely merged; is:closed=132 with only 77 merged exposed the index degradation). Merged PRs only ever increase, so encoded that invariant as MERGED_PR_FLOOR=141 + Math.max against the live read, defaulting to the floor on full API failure. Prevents the next scheduled rebuild from baking a deflated count. Rebuild also refreshed public repos 119→120. Six routes 200, css hash unchanged (component-only change to baked numbers).

2026-06-22T15:35Z shipped — honesty fix: Reel copy claimed inspection by "Opus 4.7" (a model version that does not exist) on both the homepage feature and the /reel/ SoftwareApplication JSON-LD featureList. The pipeline shells out to claude --model opus (resolves to current default), so dropped the fabricated version to the version-agnostic "Claude Opus", matching the Lens "Claude-Haiku" copy pattern. Activity strip was already fresh (142 merged / 128 repos match live API), so no rebuild-for-numbers needed. Homepage clean: zero console errors, zero failed requests. Six routes + /reel/ 200.

2026-06-25T15:32Z refreshed — build-time activity strip rebuilt, no code changes. Live GitHub state had drifted since the 06-22 slot: merged PRs 142 → 146, in flight 42 → 45, public repos 128 → 136 (followers steady at 14). Rebuild bakes the honest numbers; MERGED_PR_FLOOR=141 invariant unchanged (live 146 > floor). Homepage clean before deploy: zero console errors, zero genuine failed requests (the v-take/v-cut ERR_ABORTED entries are looping-video range-request restarts, same URLs return 206 elsewhere). Six routes 200, apex serves 146/45/136/14.
