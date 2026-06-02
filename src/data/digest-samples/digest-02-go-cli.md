---
slug: digest-02-go-cli
status: draft
purpose: Second canonical Friday digest sample for /maintains/ rotation.
voice: Tight, periods over flourishes, no em dashes, real chores not platitudes.
hypothetical_repo: owner/keenctl
hypothetical_kind: Go CLI for inspecting Kubernetes admission-controller traces.
notes: Distinct from digest-01 by carrying a security-disclosure handoff, a flaky-CI attribution, a contributor onboarding moment, and a real go.mod judgment call.
---

# Friday digest #07 · owner/keenctl

From: truffle@truffleagent.com
To:   you@owner.tld
Date: Friday, 16:08
Subject: This week at owner/keenctl · Friday digest #07

Hey. Week ending Friday is below. Four items need your call. The rest is for the record.

## Shipped

- 5 PRs merged (9 commits, +318 -127 lines). Full list at the bottom.
- 2 dependency PRs landed clean on CI: `k8s.io/client-go v0.31.4`, `cobra v1.10.1`.
- Release notes for v0.6.2 drafted, tagged, and pushed Tuesday at 09:14. Goreleaser ran green, all six assets up.
- Doc-drift audit closed three stale flag references in `docs/usage/inspect.md` after `--output yaml` was renamed to `--format yaml` in v0.6.0.

## Triaged

- 11 issues labelled and first-replied. 3 dupes closed against #412, 4 routed to discussion, 2 needs-repro, 2 confirmed bugs.
- 3h 47m average first-response time this week.
- Oldest open issue is #218, 41 days, waiting on the reporter for a kube-apiserver log line since week 2.

## Pending you

1. **#451 looks like a security-shape report.** A user described a path where a malformed admission-review JSON crashes the CLI with a panic that leaks the in-memory webhook config. I have not posted publicly and the issue is currently `severity:potential-security`. Standard disclosure flow says we move this to a private advisory and email the reporter for coordinated handoff. I have a draft advisory ready. You confirm and I open it.
2. **PR #449** (`go 1.22 -> 1.23` in go.mod). Tests pass on 1.23 but the goreleaser build matrix still pins 1.22. Dropping 1.22 simplifies CI; keeping it costs one extra row in the matrix and a deprecation timer that ends in December. I lean drop. Your call.
3. **Release notes for v0.6.3** are drafted and waiting on your nod to tag. Two user-visible changes plus one bug fix; nothing breaking.
4. **First-time contributor on PR #444** asked twice about how to run the integration suite. The doc is correct but buried. I am happy to push a one-paragraph addition to `CONTRIBUTING.md` if you want it standardized, otherwise I will keep answering inline.

## Watching

- **CI flake on `e2e-kind-1.31`** fired 3 of 9 runs this week, always at the `kubectl wait --for=condition=ready` step. Same shape as upstream kind#3641 which was patched in kind v0.24.0. We are pinned to v0.23.0 in the runner action. Bump after v0.6.3 ships.
- **#438** (memory growth on long-running `keenctl watch`). One repro, can't get a second. If a third reporter shows up I will bisect against v0.6.0 and v0.6.1.
- **`client-go v0.32.0` lands next week** per upstream cadence. It carries the `discovery.OpenAPIV3SchemaInterface` rename. I have the diff ready locally; will open the PR Monday with the call-site updates.

## Coming up

- Mon: weekly dependency PR batch, plus the client-go v0.32 PR.
- Tue: triage sweep over the four issues from this week still in needs-repro.
- Wed: doc-drift audit on `docs/admission/` (changed most in the last 30 days).
- Thu: release notes draft for v0.6.3 if you tag mid-week.
- Fri: this digest, on time.

## Every PR this week

- #443  Fix panic on empty `--field-selector` value
- #445  Extract `formatAdmissionReview` into its own package
- #446  client-go v0.31.4
- #447  cobra v1.10.1
- #448  Document `--format yaml` rename in `docs/usage/inspect.md`

Truffle
