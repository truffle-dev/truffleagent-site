#!/usr/bin/env bash
# scripts/smoke-take.sh
# Post-deploy smoke gate for Take. Hits every user-facing endpoint and asserts
# the expected HTTP status + minimal payload shape. Exits 0 on all-pass.
#
# Usage:
#   bash scripts/smoke-take.sh [BASE_URL] [PIECE_ID]
#
# PIECE_ID is optional: until a golden completed piece exists, the piece-bound
# checks (status / video / sheet) are skipped and only the always-on surface
# (create-validation, gallery, bad-id rejection, key whitelists) is asserted.
# Zero Luma/claude spend: nothing here creates a piece or advances a state.

set -euo pipefail

BASE_URL="${1:-https://truffleagent.com}"
PIECE_ID="${2:-}"

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
  local label="$1"; shift
  local url="$1"; shift
  local want="$1"; shift
  local got
  got=$(curl -s -o /dev/null -w "%{http_code}" "$@" "$url" || echo "000")
  if [[ ",$want," == *",$got,"* ]]; then
    ok "$label  ->  HTTP $got"
  else
    bad "$label  ->  HTTP $got (want one of $want)" "$url"
  fi
}

check_json_ok() {
  local label="$1"; shift
  local url="$1"; shift
  local body status
  body=$(curl -s -w "\n%{http_code}" "$@" "$url" || echo $'\n000')
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [[ "$status" != "200" ]]; then
    bad "$label  ->  HTTP $status (want 200)" "$(echo "$body" | head -c 200)"
    return
  fi
  if echo "$body" | grep -q '"ok":true'; then
    ok "$label  ->  HTTP 200 ok:true"
  else
    bad "$label  ->  HTTP 200 but ok:true missing" "$(echo "$body" | head -c 200)"
  fi
}

check_content_type() {
  local label="$1"; shift
  local url="$1"; shift
  local want="$1"; shift
  local headers status ct
  headers=$(curl -sI "$url" || true)
  status=$(printf '%s\n' "$headers" | awk 'NR==1{print $2}')
  ct=$(printf '%s\n' "$headers" | awk -F': ' 'tolower($1)=="content-type"{print tolower($2)}' | tr -d '\r')
  if [[ "$status" == "200" ]] && [[ "$ct" == *"$want"* ]]; then
    ok "$label  ->  HTTP 200, Content-Type: $ct"
  else
    bad "$label  ->  HTTP $status, Content-Type: ${ct:-<missing>} (want $want)" "$url"
  fi
}

say "Take smoke test against $BASE_URL"
say "  piece_id = ${PIECE_ID:-<none — piece-bound checks skipped>}"
say ""

# --- 1. create rejects an empty prompt (validation path, no spend) ---
say "[1] POST /api/take/create (empty prompt -> 400)"
check_status "create validation" "$BASE_URL/api/take/create" "400" \
  -X POST -H "Content-Type: application/json" -d '{"prompt":""}'

# --- 2. create rejects a non-JSON body ---
say "[2] POST /api/take/create (bad json -> 400)"
check_status "create bad json" "$BASE_URL/api/take/create" "400" \
  -X POST -H "Content-Type: application/json" -d 'not-json'

# --- 3. status rejects a malformed id ---
say "[3] GET /api/take/status/<bogus> -> 400"
check_status "status (bad id)" "$BASE_URL/api/take/status/not-a-take-id" "400"

# --- 4. status 404s an unknown but well-formed id ---
say "[4] GET /api/take/status/tk_zzzzzzzzzzzz -> 404"
check_status "status (unknown id)" "$BASE_URL/api/take/status/tk_zzzzzzzzzzzz" "404"

# --- 5. events endpoint validates ids ---
say "[5] GET /api/take/events/<bogus> -> 400"
check_status "events (bad id)" "$BASE_URL/api/take/events/not-a-take-id" "400"

# --- 6. gallery returns ok:true ---
say "[6] GET /api/take/gallery"
check_json_ok "gallery" "$BASE_URL/api/take/gallery"

# --- 7. v-take whitelist rejects traversal-shaped keys ---
say "[7] GET /v-take/<bad key> -> 404"
check_status "v-take whitelist" "$BASE_URL/v-take/video/../secrets.mp4" "404" --path-as-is

# --- 8. i-take whitelist rejects non-matching keys ---
say "[8] GET /i-take/<bad key> -> 404"
check_status "i-take whitelist" "$BASE_URL/i-take/anything/else.png" "404"

# --- piece-bound checks (need a completed golden piece) ---
if [[ -n "$PIECE_ID" ]]; then
  say "[9] GET /api/take/status/$PIECE_ID"
  check_json_ok "status (golden id)" "$BASE_URL/api/take/status/$PIECE_ID"

  say "[10] GET /api/take/events/$PIECE_ID"
  check_json_ok "events (golden id)" "$BASE_URL/api/take/events/$PIECE_ID"

  say "[11] GET /v-take/video/$PIECE_ID/1.mp4"
  check_content_type "video attempt 1" "$BASE_URL/v-take/video/$PIECE_ID/1.mp4" "video/mp4"

  say "[12] GET /i-take/sheet/$PIECE_ID/1.jpg"
  check_content_type "contact sheet" "$BASE_URL/i-take/sheet/$PIECE_ID/1.jpg" "image/jpeg"

  say "[13] Range request returns 206"
  got=$(curl -s -o /dev/null -w "%{http_code}" -H "Range: bytes=0-1023" \
    "$BASE_URL/v-take/video/$PIECE_ID/1.mp4" || echo "000")
  if [[ "$got" == "206" ]]; then
    ok "range request  ->  HTTP 206"
  else
    bad "range request  ->  HTTP $got (want 206)"
  fi
fi

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
