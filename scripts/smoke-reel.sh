#!/usr/bin/env bash
# scripts/smoke-reel.sh
# Post-deploy smoke gate for Reel. Hits every user-facing endpoint against a
# known-good piece id and asserts the expected HTTP status + minimal payload
# shape. Exits 0 on all-pass, 1 + diagnostic on any failure.
#
# Usage:
#   bash scripts/smoke-reel.sh [BASE_URL] [PIECE_ID]
#
# Defaults:
#   BASE_URL  = https://truffleagent.com
#   PIECE_ID  = rl_mq5gremf9vsdvoy06wpnv     # golden retriever, completed,
#                                            # has narration audio in R2
#
# Designed to be cheap (no Luma/ElevenLabs spend — synthesize-narration is
# idempotent and returns cached audio when narration_status='ready'). Safe
# to run from cron after every deploy.

set -euo pipefail

BASE_URL="${1:-https://truffleagent.com}"
PIECE_ID="${2:-rl_mq5gremf9vsdvoy06wpnv}"

FAIL=0
PASS=0
FAILURES=()

# Pretty-printer
say() { printf '%s\n' "$*"; }
ok()  { PASS=$((PASS+1)); say "  ok   $1"; }
bad() {
  FAIL=$((FAIL+1))
  FAILURES+=("$1")
  say "  FAIL $1"
  [[ -n "${2:-}" ]] && say "       $2"
}

# check_status <label> <url> <expected_status_csv> [extra_curl_opts...]
# expected_status_csv accepts multiple OK statuses, e.g. "200,302".
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

# check_json_ok <label> <url> [extra_curl_opts...]
# Asserts HTTP 200 AND body contains "\"ok\":true".
check_json_ok() {
  local label="$1"; shift
  local url="$1"; shift
  local body status
  body=$(curl -s -w "\n%{http_code}" "$@" "$url" || echo $'\n000')
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [[ "$status" != "200" ]]; then
    bad "$label  ->  HTTP $status (want 200)" "$body"
    return
  fi
  if echo "$body" | grep -q '"ok":true'; then
    ok "$label  ->  HTTP 200 ok:true"
  else
    bad "$label  ->  HTTP 200 but ok:true missing" "$(echo "$body" | head -c 200)"
  fi
}

# check_content_type <label> <url> <expected_ct_substring>
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

say "Reel smoke test against $BASE_URL"
say "  piece_id = $PIECE_ID"
say ""

# --- 1. JSON status endpoint ---
say "[1/8] GET /api/reel/status/<id>"
check_json_ok "status (good id)" "$BASE_URL/api/reel/status/$PIECE_ID"

# --- 2. Bad id returns 400 with bad_id code ---
say "[bonus] GET /api/reel/status/<bogus>"
check_status "status (bad id)" "$BASE_URL/api/reel/status/this-is-not-a-piece-id" "400"

# --- 3. Reader page (slug) is HTML 200 ---
say "[2/8] GET /reel/<slug>/  (resolve slug from status)"
slug=$(curl -s "$BASE_URL/api/reel/status/$PIECE_ID" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p' | head -1)
if [[ -z "$slug" ]]; then
  bad "reader slug resolve" "could not extract slug from status response"
else
  check_status "reader page" "$BASE_URL/reel/$slug/" "200"
fi

# --- 4. Draft page is HTML 200 (in-flight) or 302 to reader (completed) ---
say "[3/8] GET /reel/draft/<id>/"
check_status "draft page" "$BASE_URL/reel/draft/$PIECE_ID/" "200,302"

# --- 5. Master ref image ---
say "[4/8] GET /i-reel/master/<id>.png"
check_content_type "master image" "$BASE_URL/i-reel/master/$PIECE_ID.png" "image/"

# --- 6. Frame 1 image ---
say "[5/8] GET /i-reel/frame/<id>/1.png"
check_content_type "frame 1 image" "$BASE_URL/i-reel/frame/$PIECE_ID/1.png" "image/"

# --- 7. Narration synth (idempotent, no spend on cached row) ---
say "[6/8] POST /api/reel/synthesize-narration/<id>"
check_json_ok "narration synth (cached)" \
  "$BASE_URL/api/reel/synthesize-narration/$PIECE_ID" \
  -X POST -H "Content-Type: application/json" -d '{}'

# --- 8. Narration audio file in R2 ---
say "[7/8] GET /audio-reel/narration/<id>.mp3"
check_content_type "narration audio" "$BASE_URL/audio-reel/narration/$PIECE_ID.mp3" "audio/"

# --- 9. Public gallery ---
say "[8/8] GET /api/reel/gallery"
check_json_ok "gallery" "$BASE_URL/api/reel/gallery"

say ""
say "----"
say "Passed: $PASS"
say "Failed: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  say ""
  say "Failures:"
  for f in "${FAILURES[@]}"; do
    say "  - $f"
  done
  exit 1
fi

exit 0
