#!/usr/bin/env bash
# scripts/smoke-cut.sh
# Post-deploy smoke gate for Cut. Hits every user-facing endpoint and asserts
# the expected HTTP status + minimal payload shape. Exits 0 on all-pass.
#
# Usage:
#   bash scripts/smoke-cut.sh [BASE_URL] [PIECE_ID]
#
# PIECE_ID is optional: until a golden completed piece exists, the piece-bound
# checks (status / final video / sheets / revise-409) are skipped and only the
# always-on surface (create-validation, gallery, bad-id rejection, key
# whitelists, page routes) is asserted. Zero Luma/claude spend: nothing here
# creates a piece or advances a state. The status driver only advances pieces
# that exist, and we only poll the golden (already-completed) one.

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

say "Cut smoke test against $BASE_URL"
say "  piece_id = ${PIECE_ID:-<none — piece-bound checks skipped>}"
say ""

# --- 1. create rejects an empty prompt (validation path, no spend) ---
say "[1] POST /api/cut/create (empty prompt -> 400)"
check_status "create validation" "$BASE_URL/api/cut/create" "400" \
  -X POST -H "Content-Type: application/json" -d '{"prompt":""}'

# --- 2. create rejects a non-JSON body ---
say "[2] POST /api/cut/create (bad json -> 400)"
check_status "create bad json" "$BASE_URL/api/cut/create" "400" \
  -X POST -H "Content-Type: application/json" -d 'not-json'

# --- 3. create rejects a bad target_seconds ---
say "[3] POST /api/cut/create (target_seconds=7 -> 400)"
check_status "create bad length" "$BASE_URL/api/cut/create" "400" \
  -X POST -H "Content-Type: application/json" -d '{"prompt":"a perfectly fine prompt about a paper boat","target_seconds":7}'

# --- 4. status rejects a malformed id ---
say "[4] GET /api/cut/status/<bogus> -> 400"
check_status "status (bad id)" "$BASE_URL/api/cut/status/not-a-cut-id" "400"

# --- 5. status 404s an unknown but well-formed id ---
say "[5] GET /api/cut/status/cu_zzzzzzzzzzzz -> 404"
check_status "status (unknown id)" "$BASE_URL/api/cut/status/cu_zzzzzzzzzzzz" "404"

# --- 6. events endpoint validates ids ---
say "[6] GET /api/cut/events/<bogus> -> 400"
check_status "events (bad id)" "$BASE_URL/api/cut/events/not-a-cut-id" "400"

# --- 7. revise validates ids ---
say "[7] POST /api/cut/revise/<bogus> -> 400"
check_status "revise (bad id)" "$BASE_URL/api/cut/revise/not-a-cut-id" "400" \
  -X POST -H "Content-Type: application/json" -d '{"message":"tighten the middle"}'

# --- 8. gallery returns ok:true ---
say "[8] GET /api/cut/gallery"
check_json_ok "gallery" "$BASE_URL/api/cut/gallery"

# --- 9. v-cut whitelist rejects traversal-shaped keys ---
say "[9] GET /v-cut/<bad key> -> 404"
check_status "v-cut whitelist" "$BASE_URL/v-cut/final/../secrets.mp4" "404" --path-as-is

# --- 10. i-cut whitelist rejects non-matching keys ---
say "[10] GET /i-cut/<bad key> -> 404"
check_status "i-cut whitelist" "$BASE_URL/i-cut/anything/else.png" "404"

# --- 11. landing page renders ---
say "[11] GET /cut/ -> 200"
check_status "landing page" "$BASE_URL/cut/" "200"

# --- 12. learn page falls through the slug catch-all ---
say "[12] GET /cut/learn -> 200,308"
check_status "learn page" "$BASE_URL/cut/learn" "200,308"

# --- 13. unknown slug 404s (not 500) ---
say "[13] GET /cut/definitely-not-a-real-slug -> 404"
check_status "unknown slug" "$BASE_URL/cut/definitely-not-a-real-slug-zzz" "404"

# --- 14. draft page validates ids ---
say "[14] GET /cut/draft/<bogus> -> 400,404"
check_status "draft (bad id)" "$BASE_URL/cut/draft/not-a-cut-id" "400,404"

# --- piece-bound checks (need a completed golden piece) ---
if [[ -n "$PIECE_ID" ]]; then
  say "[15] GET /api/cut/status/$PIECE_ID"
  check_json_ok "status (golden id)" "$BASE_URL/api/cut/status/$PIECE_ID"

  say "[16] GET /api/cut/events/$PIECE_ID"
  check_json_ok "events (golden id)" "$BASE_URL/api/cut/events/$PIECE_ID"

  say "[17] GET /cut/draft/$PIECE_ID -> 200,302"
  check_status "draft (golden id)" "$BASE_URL/cut/draft/$PIECE_ID" "200,302"

  # Resolve the golden piece's final keys + slug from the status payload.
  snap=$(curl -s "$BASE_URL/api/cut/status/$PIECE_ID" || echo "{}")
  final_url=$(echo "$snap" | grep -o '"final_url":"[^"]*"' | head -1 | cut -d'"' -f4)
  sheet_url=$(echo "$snap" | grep -o '"final_sheet_url":"[^"]*"' | head -1 | cut -d'"' -f4)
  slug=$(echo "$snap" | grep -o '"slug":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [[ -n "$final_url" ]]; then
    say "[18] GET $final_url"
    check_content_type "final video" "$BASE_URL$final_url" "video/mp4"

    say "[19] Range request returns 206"
    got=$(curl -s -o /dev/null -w "%{http_code}" -H "Range: bytes=0-1023" \
      "$BASE_URL$final_url" || echo "000")
    if [[ "$got" == "206" ]]; then
      ok "range request  ->  HTTP 206"
    else
      bad "range request  ->  HTTP $got (want 206)"
    fi
  else
    bad "final_url missing from status payload" "$(echo "$snap" | head -c 200)"
  fi

  if [[ -n "$sheet_url" ]]; then
    say "[20] GET $sheet_url"
    check_content_type "final contact sheet" "$BASE_URL$sheet_url" "image/jpeg"
  fi

  if [[ -n "$slug" ]]; then
    say "[21] GET /cut/$slug -> 200"
    check_status "piece page" "$BASE_URL/cut/$slug" "200"
  fi

  # Revise on a piece whose rounds may or may not be spent: 200 (chat-only or
  # routed) and 409 (exhausted/busy) are both healthy; 4xx-other/5xx are not.
  # Note: a 200 here can consume a revision round on the golden piece, so we
  # send a message the router should answer chat-only ("no edit needed").
  say "[22] POST /api/cut/revise/$PIECE_ID (chat-shaped message)"
  got=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d '{"message":"What would you say is the strongest shot in this piece?"}' \
    "$BASE_URL/api/cut/revise/$PIECE_ID" || echo "000")
  if [[ "$got" == "200" || "$got" == "409" ]]; then
    ok "revise (golden id)  ->  HTTP $got"
  else
    bad "revise (golden id)  ->  HTTP $got (want 200 or 409)"
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
