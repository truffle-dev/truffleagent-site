#!/usr/bin/env bash
# scripts/deploy-take.sh
# Single-entry safe-deploy wrapper for the Take surface of truffleagent.com.
# Mirrors deploy-reel.sh: sanity, drift warn, migration lockstep, build,
# deploy, propagation wait, smoke, done.
#
# Usage:
#   bash scripts/deploy-take.sh                      # normal deploy
#   bash scripts/deploy-take.sh --skip-smoke         # build + deploy only
#   bash scripts/deploy-take.sh --dry-run            # build only
#   TAKE_GOLDEN_PIECE=tk_xxx bash scripts/deploy-take.sh   # piece-bound smoke

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
[[ -f "$REPO_ROOT/wrangler.toml" ]] || die "wrangler.toml not found — wrong directory?"
if [[ -f "$HOME/.config/truffle/env.sh" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.config/truffle/env.sh"
fi
command -v wrangler >/dev/null 2>&1 || die "wrangler not on PATH after sourcing env.sh"
echo "  cwd: $REPO_ROOT"
echo "  wrangler: $(wrangler --version 2>&1 | head -1)"

# --- Step 2: drift check ---
step "2/8  Drift check"
dirty=$(git status --short 2>/dev/null || true)
if [[ -n "$dirty" ]]; then
  echo "  dirty files:"
  echo "$dirty" | sed 's/^/    /'
  unrelated=$(echo "$dirty" | awk '{print $2}' | grep -v -E '(functions/(api/take|v-take|i-take)|functions/_take-shared|migrations/000[0-9]_take|scripts/(smoke|deploy)-take|src/pages/take|src/components/take)' || true)
  if [[ -n "$unrelated" ]]; then
    echo ""
    echo "  WARN: non-take files dirty. Stash before deploy or proceed intentionally:"
    echo "$unrelated" | sed 's/^/    /'
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
[[ -d "$REPO_ROOT/dist" && -n "$(ls -A "$REPO_ROOT/dist" 2>/dev/null)" ]] || die "build produced no dist/"
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
[[ -n "$deploy_url" ]] || die "could not parse deployment URL from wrangler output"
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
  if bash "$REPO_ROOT/scripts/smoke-take.sh" https://truffleagent.com "${TAKE_GOLDEN_PIECE:-}"; then
    echo ""
    echo "  smoke green"
  else
    echo ""
    echo "  !! SMOKE RED !!"
    echo ""
    echo "  Roll back from the Cloudflare Pages dashboard:"
    echo "    https://dash.cloudflare.com/?to=/:account/pages/view/truffleagent"
    echo "  Or: wrangler pages deployment list --project-name=truffleagent"
    exit 1
  fi
fi

# --- Step 8: done ---
step "8/8  Done"
echo "  $deploy_url"
echo "  https://truffleagent.com"
exit 0
