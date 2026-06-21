#!/usr/bin/env bash
# scripts/smoke-tools.sh
# Post-deploy smoke gate for the free-tools family (/tools/ + every tool page).
# Derives the tool list from the deployed /tools/ index itself, so the index is
# the single source of truth and the script needs no edits when a tool is added.
# For each tool the index links, it asserts the page returns 200 and carries its
# own canonical <link>, which is what separates a real page from a soft-404
# fallback. Exits 0 on all-pass. Zero spend: every request is a plain GET.
#
# Usage:
#   bash scripts/smoke-tools.sh [BASE_URL]

set -euo pipefail

BASE_URL="${1:-https://truffleagent.com}"
MIN_TOOLS=20   # guard against an empty/broken extraction silently passing

FAIL=0
PASS=0
FAILURES=()

say() { printf '%s\n' "$*"; }
ok()  { PASS=$((PASS+1)); say "  ok   $1"; }
bad() {
  FAIL=$((FAIL+1))
  FAILURES+=("$1")
  say "  FAIL $1"
  [[ -n "${2:-}" ]] && say "       $2"
}

check_status() {
  local label="$1" url="$2" want="$3" got
  got=$(curl -s -o /dev/null -w "%{http_code}" "$url" || echo "000")
  if [[ ",$want," == *",$got,"* ]]; then
    ok "$label  ->  HTTP $got"
  else
    bad "$label  ->  HTTP $got (want one of $want)" "$url"
  fi
}

# 200 AND the page declares itself canonical at the expected path.
check_page() {
  local slug="$1" url="$BASE_URL/$1/" body status
  body=$(curl -s -w "\n%{http_code}" "$url" || echo $'\n000')
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [[ "$status" != "200" ]]; then
    bad "/$slug/  ->  HTTP $status (want 200)" "$url"
    return
  fi
  if printf '%s' "$body" | grep -qiE "rel=\"canonical\"[^>]*href=\"https://truffleagent.com/$slug/\""; then
    ok "/$slug/  ->  HTTP 200, canonical present"
  else
    bad "/$slug/  ->  HTTP 200 but canonical link missing or wrong" \
      "expected canonical https://truffleagent.com/$slug/ (possible soft-404 fallback)"
  fi
}

say "Tools smoke test against $BASE_URL"
say ""

# --- 1. the directory itself must load ---
say "[1] GET /tools/"
check_status "tools index" "$BASE_URL/tools/" "200"

# --- 2. extract the tool slugs the index links via the tool-card anchors ---
say "[2] discover tool slugs from /tools/"
INDEX_HTML=$(curl -s "$BASE_URL/tools/" || true)
mapfile -t SLUGS < <(
  printf '%s' "$INDEX_HTML" \
    | grep -oE 'tool-card"[^>]*href="/[^"/]+/"' \
    | grep -oE 'href="/[^"/]+/"' \
    | sed -E 's#href="/([^"/]+)/"#\1#' \
    | sort -u
)
COUNT=${#SLUGS[@]}
if [[ "$COUNT" -ge "$MIN_TOOLS" ]]; then
  ok "discovered $COUNT tools: ${SLUGS[*]}"
else
  bad "discovered only $COUNT tools (want >= $MIN_TOOLS)" \
    "extraction may be broken, or the index lost its tool cards"
fi

# --- 3. every linked tool page must resolve to its own canonical page ---
say "[3] verify each linked tool page"
for slug in "${SLUGS[@]}"; do
  check_page "$slug"
done

# --- 4. a couple of always-on anchors ---
say "[4] anchor pages"
check_status "home" "$BASE_URL/" "200"
check_status "og image" "$BASE_URL/img/og.jpg" "200"

say ""
say "----"
say "Passed: $PASS"
say "Failed: $FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  say ""
  say "Failures:"
  for f in "${FAILURES[@]}"; do say "  - $f"; done
  exit 1
fi
exit 0
