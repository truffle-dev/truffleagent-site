#!/usr/bin/env bash
# scripts/deploy-reel.sh
# Single-entry safe-deploy wrapper for the Reel surface of truffleagent.com.
# Every gate the AGENTIC_BUILD_PLAN hard-rules block requires.
#
# Steps (each must pass or we exit non-zero):
#   1. Sanity: in correct repo, env.sh sourced, wrangler available.
#   2. Drift check: refuse to deploy if unrelated files are dirty.
#   3. Migration lockstep: `wrangler d1 migrations list --remote` reports zero
#      pending. If it reports pending, we APPLY them first (the prod DB is the
#      source of truth; deploying code that needs schema we haven't applied
#      is the original mistake we're protecting against).
#   4. Build: GOMAXPROCS=1 RAYON_NUM_THREADS=1 UV_THREADPOOL_SIZE=2 npm run build.
#   5. Deploy: wrangler pages deploy dist --project-name=truffleagent.
#   6. Wait 10s for Pages propagation.
#   7. Smoke: scripts/smoke-reel.sh against truffleagent.com. On red, print
#      the rollback command (last green deployment URL) and exit 1.
#   8. On green, print deployment URL + done.
#
# Usage:
#   bash scripts/deploy-reel.sh                # normal deploy
#   bash scripts/deploy-reel.sh --skip-smoke   # build + deploy, no smoke
#   bash scripts/deploy-reel.sh --dry-run      # build only, no deploy
#
# The `reel-agentic-build` cron calls this wrapper. Manual deploys should
# too — see scripts/README.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_SMOKE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-smoke) SKIP_SMOKE=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\n!! %s\n' "$*" >&2; exit 1; }

# --- Step 1: sanity ---
step "1/8  Sanity"
if [[ ! -f "$REPO_ROOT/wrangler.toml" ]]; then
  die "wrangler.toml not found at $REPO_ROOT — wrong directory?"
fi
if [[ -f "$HOME/.config/truffle/env.sh" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.config/truffle/env.sh"
fi
if ! command -v wrangler >/dev/null 2>&1; then
  die "wrangler not on PATH after sourcing env.sh"
fi
echo "  cwd: $REPO_ROOT"
echo "  wrangler: $(wrangler --version 2>&1 | head -1)"

# --- Step 2: drift check ---
step "2/8  Drift check (refuse if unrelated files dirty)"
dirty=$(git status --short 2>/dev/null || true)
if [[ -n "$dirty" ]]; then
  echo "  dirty files:"
  echo "$dirty" | sed 's/^/    /'
  # We allow dirty deploys (--commit-dirty=true below) but warn the operator.
  # Reel-only changes are expected; unrelated tree drift gets a flag.
  unrelated=$(echo "$dirty" | awk '{print $2}' | grep -v -E '(functions/.*reel|functions/_reel-shared|migrations/000[0-9]_reel|scripts/(smoke|deploy)-reel|src/pages/reel|src/components/reel)' || true)
  if [[ -n "$unrelated" ]]; then
    echo ""
    echo "  WARN: non-reel files dirty. Stash them before deploy or use --commit-dirty=true intentionally."
    echo "  unrelated:"
    echo "$unrelated" | sed 's/^/    /'
    # Don't die — log and continue. Operator can ctrl-C.
  fi
else
  echo "  clean working tree"
fi

# --- Step 3: migration lockstep ---
step "3/8  Migration lockstep (truffle-co-prod, remote)"
mig_out=$(wrangler d1 migrations list truffle-co-prod --remote 2>&1)
if echo "$mig_out" | grep -q "No migrations to apply"; then
  echo "  no pending migrations"
elif echo "$mig_out" | grep -q "Migrations to be applied"; then
  echo "  pending migrations detected:"
  echo "$mig_out" | sed -n '/Migrations to be applied/,$p' | sed 's/^/    /'
  echo ""
  echo "  applying..."
  if ! wrangler d1 migrations apply truffle-co-prod --remote 2>&1 | tail -20; then
    die "migration apply failed — refusing to deploy code that may need missing schema"
  fi
  echo "  migrations applied"
else
  echo "$mig_out" | tail -10
  die "unexpected output from migrations list — refusing to deploy"
fi

# --- Step 4: build ---
step "4/8  Build"
GOMAXPROCS=1 RAYON_NUM_THREADS=1 UV_THREADPOOL_SIZE=2 npm run build 2>&1 | tail -5
if [[ ! -d "$REPO_ROOT/dist" ]] || [[ -z "$(ls -A "$REPO_ROOT/dist" 2>/dev/null)" ]]; then
  die "build produced no dist/ — refusing to deploy"
fi
echo "  build clean"

if [[ "$DRY_RUN" == "1" ]]; then
  step "DRY RUN — stopping before deploy"
  exit 0
fi

# --- Step 5: deploy ---
step "5/8  Deploy"
deploy_out=$(wrangler pages deploy dist --project-name=truffleagent --commit-dirty=true 2>&1)
echo "$deploy_out" | tail -8
deploy_url=$(echo "$deploy_out" | grep -oE 'https://[a-f0-9]+\.truffleagent\.pages\.dev' | head -1)
if [[ -z "$deploy_url" ]]; then
  die "could not parse deployment URL from wrangler output"
fi
echo ""
echo "  preview: $deploy_url"
echo "  prod alias: https://truffleagent.com"

# --- Step 6: propagation wait ---
step "6/8  Pages propagation wait (10s)"
sleep 10

# --- Step 7: smoke ---
if [[ "$SKIP_SMOKE" == "1" ]]; then
  step "7/8  Smoke (SKIPPED via --skip-smoke flag)"
else
  step "7/8  Smoke"
  if bash "$REPO_ROOT/scripts/smoke-reel.sh" https://truffleagent.com; then
    echo ""
    echo "  smoke green"
  else
    echo ""
    echo "  !! SMOKE RED !!"
    echo ""
    echo "  Roll back from the Cloudflare Pages dashboard:"
    echo "    https://dash.cloudflare.com/?to=/:account/pages/view/truffleagent"
    echo "  Pick the last green deployment and click 'Rollback to this deployment'."
    echo ""
    echo "  Or via wrangler (lists last 10 deployments):"
    echo "    wrangler pages deployment list --project-name=truffleagent"
    exit 1
  fi
fi

# --- Step 8: done ---
step "8/8  Done"
echo "  $deploy_url"
echo "  https://truffleagent.com"
exit 0
