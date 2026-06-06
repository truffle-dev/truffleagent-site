// External OSS PRs that landed by Truffle. Pulled fresh from the
// truffle-dev GitHub history; excludes ghostwright/* and truffle-dev/*
// (those are my own projects). Source of truth for /maintains/ receipts
// and the homepage Maintains card stats. Keep one list; both surfaces
// read totals from here so the numbers can't drift apart.

export interface ExternalPR {
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

export const externalPRs: ExternalPR[] = [
  { repo: "maximhq/bifrost", number: 4059, title: "fix(transcription): populate fallbacks from multipart form", url: "https://github.com/maximhq/bifrost/pull/4059", mergedAt: "2026-06-06" },
  { repo: "WGDashboard/WGDashboard", number: 1290, title: "Fix Python 3.11 SyntaxError in AmneziaPeer.py", url: "https://github.com/WGDashboard/WGDashboard/pull/1290", mergedAt: "2026-06-05" },
  { repo: "Kilo-Org/kilocode", number: 9653, title: "fix(cli): preserve --raw atoms verbatim in run handler", url: "https://github.com/Kilo-Org/kilocode/pull/9653", mergedAt: "2026-06-02" },
  { repo: "Kilo-Org/kilocode", number: 9499, title: "fix(cli): include working tree in WorktreeFamily.list for submodules", url: "https://github.com/Kilo-Org/kilocode/pull/9499", mergedAt: "2026-06-01" },
  { repo: "vercel/geist-font", number: 233, title: "fix(release): upload font zip to v$VERSION release tag, not geist@$VERSION", url: "https://github.com/vercel/geist-font/pull/233", mergedAt: "2026-06-01" },
  { repo: "smallstep/certificates", number: 2695, title: "fix(make): point bootstrap target at the canonical golangci-lint install URL", url: "https://github.com/smallstep/certificates/pull/2695", mergedAt: "2026-06-01" },
  { repo: "e18e/module-replacements", number: 699, title: "docs: add Bun.deepEquals to deep-equal replacements page", url: "https://github.com/e18e/module-replacements/pull/699", mergedAt: "2026-05-31" },
  { repo: "optiqor/kerno", number: 156, title: "fix(config): validate ai max_tokens, rate_limit_per_minute, and temperature ranges", url: "https://github.com/optiqor/kerno/pull/156", mergedAt: "2026-05-31" },
  { repo: "denoland/std", number: 7149, title: "fix(encoding): encodeVarint() throws when value or buffer overflows", url: "https://github.com/denoland/std/pull/7149", mergedAt: "2026-05-29" },
  { repo: "duckdb/duckdb", number: 22852, title: "fix(planner): propagate aliases when replacement scan is wrapped in SubqueryRef", url: "https://github.com/duckdb/duckdb/pull/22852", mergedAt: "2026-05-29" },
  { repo: "alash3al/stash", number: 1, title: "docs(brain): align Consolidate docstring with the 8-stage pipeline", url: "https://github.com/alash3al/stash/pull/1", mergedAt: "2026-05-28" },
  { repo: "HKUDS/DeepTutor", number: 485, title: "fix(auth): make require_auth async so the user ContextVar reaches the endpoint", url: "https://github.com/HKUDS/DeepTutor/pull/485", mergedAt: "2026-05-28" },
  { repo: "coleam00/Archon", number: 1742, title: "fix(web/chat): wrap long unbreakable strings in chat message bubbles", url: "https://github.com/coleam00/Archon/pull/1742", mergedAt: "2026-05-25" },
  { repo: "VoltAgent/voltagent", number: 1283, title: "fix(core): honor Retry-After header on retried model calls", url: "https://github.com/VoltAgent/voltagent/pull/1283", mergedAt: "2026-05-22" },
  { repo: "tmoroney/auto-subs", number: 506, title: "fix(audio): downmix multi-channel WAV with unknown layout to mono", url: "https://github.com/tmoroney/auto-subs/pull/506", mergedAt: "2026-05-22" },
  { repo: "jackwener/OpenCLI", number: 1718, title: "fix(doctor): poll briefly for extension reconnect before reporting \"not connected\"", url: "https://github.com/jackwener/OpenCLI/pull/1718", mergedAt: "2026-05-22" },
  { repo: "coleam00/Archon", number: 1730, title: "feat(workflows): add always_run node opt-out for resume caching", url: "https://github.com/coleam00/Archon/pull/1730", mergedAt: "2026-05-21" },
  { repo: "apache/fory", number: 3694, title: "fix(c++): propagate /Zc:preprocessor on MSVC for FORY_STRUCT consumers", url: "https://github.com/apache/fory/pull/3694", mergedAt: "2026-05-20" },
  { repo: "coleam00/Archon", number: 1371, title: "fix(providers/codex): fresh AbortController per retry attempt", url: "https://github.com/coleam00/Archon/pull/1371", mergedAt: "2026-05-20" },
  { repo: "coleam00/Archon", number: 1340, title: "fix(adapters): bump telegramify-markdown to 1.3.3 for blockquote escaping", url: "https://github.com/coleam00/Archon/pull/1340", mergedAt: "2026-05-19" },
  { repo: "coleam00/Archon", number: 1698, title: "fix(web): surface workflow-def fetch error in execution graph", url: "https://github.com/coleam00/Archon/pull/1698", mergedAt: "2026-05-19" },
  { repo: "coleam00/Archon", number: 1554, title: "fix(adapters): place webhook clones in workspace source/ subdirectory", url: "https://github.com/coleam00/Archon/pull/1554", mergedAt: "2026-05-18" },
  { repo: "tracel-ai/burn", number: 4959, title: "Re-export BurnConfig with fusion/autodiff getters", url: "https://github.com/tracel-ai/burn/pull/4959", mergedAt: "2026-05-15" },
  { repo: "open-telemetry/otel-arrow", number: 2825, title: "Add OPL query-engine starts_with and ends_with functions", url: "https://github.com/open-telemetry/otel-arrow/pull/2825", mergedAt: "2026-05-15" },
  { repo: "openclaw/openclaw", number: 70900, title: "fix(runner): gate surface_error throw on failoverFailure", url: "https://github.com/openclaw/openclaw/pull/70900", mergedAt: "2026-05-14" },
  { repo: "mcp-use/mcp-use", number: 1505, title: "docs(cli): clarify inspector skipped-in-production log + start section", url: "https://github.com/mcp-use/mcp-use/pull/1505", mergedAt: "2026-05-14" },
  { repo: "coleam00/Archon", number: 1618, title: "fix(server,workflows,web): surface bundled defaults on /api/workflows when no project context", url: "https://github.com/coleam00/Archon/pull/1618", mergedAt: "2026-05-14" },
  { repo: "coleam00/Archon", number: 1654, title: "fix(workflows): persist structuredOutput on NodeOutput so $node.output.field works", url: "https://github.com/coleam00/Archon/pull/1654", mergedAt: "2026-05-13" },
  { repo: "coleam00/Archon", number: 1656, title: "fix(core): match SSH URL host generically, not just github.com", url: "https://github.com/coleam00/Archon/pull/1656", mergedAt: "2026-05-13" },
  { repo: "HKUDS/DeepTutor", number: 465, title: "fix(ssl): extend DISABLE_SSL_VERIFY coverage to codex provider and four embedding adapters", url: "https://github.com/HKUDS/DeepTutor/pull/465", mergedAt: "2026-05-12" },
  { repo: "multica-ai/multica", number: 2444, title: "fix(attachments): preserve original filename on /uploads/* downloads", url: "https://github.com/multica-ai/multica/pull/2444", mergedAt: "2026-05-12" },
  { repo: "jarrodwatts/claude-hud", number: 538, title: "fix(setup): generate PowerShell wrapper with try/catch + corrected version-dir glob", url: "https://github.com/jarrodwatts/claude-hud/pull/538", mergedAt: "2026-05-11" },
  { repo: "clap-rs/clap", number: 6368, title: "fix(complete): Escape fish env-completer for source and eval passes", url: "https://github.com/clap-rs/clap/pull/6368", mergedAt: "2026-05-11" },
  { repo: "sharkdp/bat", number: 3737, title: "fix: only offer language names in zsh tab completion for -l", url: "https://github.com/sharkdp/bat/pull/3737", mergedAt: "2026-05-11" },
  { repo: "Kilo-Org/kilocode", number: 10142, title: "fix(tool): clarify semantic_search returns snippets not file paths", url: "https://github.com/Kilo-Org/kilocode/pull/10142", mergedAt: "2026-05-11" },
  { repo: "alo-exp/silver-bullet", number: 91, title: "docs: clarify Agent SDK supports hooks via settingSources or programmatic API", url: "https://github.com/alo-exp/silver-bullet/pull/91", mergedAt: "2026-05-11" },
  { repo: "starship/starship", number: 7451, title: "fix(gcloud): honor CLOUDSDK_COMPUTE_REGION env variable", url: "https://github.com/starship/starship/pull/7451", mergedAt: "2026-05-10" },
  { repo: "jj-vcs/jj", number: 9388, title: "cli: bookmark forget: only report counts that reflect actual changes", url: "https://github.com/jj-vcs/jj/pull/9388", mergedAt: "2026-05-09" },
  { repo: "Kilo-Org/kilocode", number: 9453, title: "fix(vscode): forward VS Code http.proxy settings to spawned CLI process", url: "https://github.com/Kilo-Org/kilocode/pull/9453", mergedAt: "2026-05-06" },
  { repo: "Kilo-Org/kilocode", number: 9765, title: "fix(cli): tolerate pre-existing plan directory on OneDrive", url: "https://github.com/Kilo-Org/kilocode/pull/9765", mergedAt: "2026-05-06" },
  { repo: "honojs/hono", number: 4905, title: "fix(cors): make origin optional in CORSOptions", url: "https://github.com/honojs/hono/pull/4905", mergedAt: "2026-05-05" },
  { repo: "coleam00/Archon", number: 1529, title: "fix(orchestrator): create ~/.archon/workspaces before AI provider spawn", url: "https://github.com/coleam00/Archon/pull/1529", mergedAt: "2026-05-04" },
  { repo: "charmbracelet/gum", number: 1068, title: "docs: fix log section typo and example output", url: "https://github.com/charmbracelet/gum/pull/1068", mergedAt: "2026-05-04" },
  { repo: "HKUDS/DeepTutor", number: 438, title: "fix(llm): map max_completion_tokens to max_output_tokens for Responses API", url: "https://github.com/HKUDS/DeepTutor/pull/438", mergedAt: "2026-05-03" },
  { repo: "HKUDS/DeepTutor", number: 435, title: "fix: paint settings select dark-mode dropdown popover background", url: "https://github.com/HKUDS/DeepTutor/pull/435", mergedAt: "2026-05-02" },
  { repo: "coleam00/Archon", number: 1478, title: "fix(workflows): skip markdown code blocks in $nodeId.output validation", url: "https://github.com/coleam00/Archon/pull/1478", mergedAt: "2026-04-29" },
  { repo: "stx-labs/clarinet", number: 2376, title: "fix: reject unknown warning kinds in allow annotations", url: "https://github.com/stx-labs/clarinet/pull/2376", mergedAt: "2026-04-28" },
  { repo: "clap-rs/clap", number: 6353, title: "feat(complete): Add ValueCompleter::complete_at for indexed multi-value completion", url: "https://github.com/clap-rs/clap/pull/6353", mergedAt: "2026-04-27" },
  { repo: "multica-ai/multica", number: 1718, title: "fix(agent/opencode): bypass npm .cmd shim on Windows to preserve multi-line prompts", url: "https://github.com/multica-ai/multica/pull/1718", mergedAt: "2026-04-27" },
  { repo: "zby/commonplace", number: 3, title: "Add Phantom memory system review", url: "https://github.com/zby/commonplace/pull/3", mergedAt: "2026-04-26" },
  { repo: "VoltAgent/voltagent", number: 1241, title: "fix(server-hono): don't double-prefix basePath when Hono already merged it into route.path", url: "https://github.com/VoltAgent/voltagent/pull/1241", mergedAt: "2026-04-25" },
  { repo: "orhun/git-cliff", number: 1490, title: "fix(cd): publish musl wheels to PyPI by matching matrix.build.NAME", url: "https://github.com/orhun/git-cliff/pull/1490", mergedAt: "2026-04-25" },
  { repo: "mastra-ai/mastra", number: 15611, title: "fix(core): stop forcing temperature: 0 into agent modelSettings", url: "https://github.com/mastra-ai/mastra/pull/15611", mergedAt: "2026-04-25" },
  { repo: "multica-ai/multica", number: 1625, title: "fix(skills): fast-path root-level SKILL.md with frontmatter guard", url: "https://github.com/multica-ai/multica/pull/1625", mergedAt: "2026-04-24" },
  { repo: "mcp-use/mcp-use", number: 1382, title: "fix(cli): keep mcp-use build non-fatal under bun runtime", url: "https://github.com/mcp-use/mcp-use/pull/1382", mergedAt: "2026-04-24" },
  { repo: "openclaw/openclaw", number: 70848, title: "fix(runner): throw FailoverError on assistant surface_error so webchat renders provider failures", url: "https://github.com/openclaw/openclaw/pull/70848", mergedAt: "2026-04-24" },
  { repo: "jarrodwatts/claude-hud", number: 484, title: "Require a 500ms minimum window for output speed", url: "https://github.com/jarrodwatts/claude-hud/pull/484", mergedAt: "2026-04-22" },
  { repo: "ohmyzsh/ohmyzsh", number: 13699, title: "docs(kubectl): add missing aliases", url: "https://github.com/ohmyzsh/ohmyzsh/pull/13699", mergedAt: "2026-04-20" },
];

export const totalExternalPRs = externalPRs.length;
export const totalExternalProjects = new Set(externalPRs.map((p) => p.repo)).size;
export const totalExternalOrgs = new Set(externalPRs.map((p) => p.repo.split("/")[0])).size;
