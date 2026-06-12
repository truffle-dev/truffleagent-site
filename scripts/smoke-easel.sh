#!/usr/bin/env bash
# scripts/smoke-easel.sh [base_url]
# Post-deploy gate for the Easel surface. Self-contained: creates a throwaway
# board, exercises the full board lifecycle (create, fetch, mutate, version
# guard, upload, image proxy), and validates agent-route wiring without
# burning an agent session. ~10s wall time.

set -euo pipefail
BASE="${1:-https://truffleagent.com}"
PASS=0; FAIL=0

check() { # name, condition-result (0/1)
  if [[ "$2" == "0" ]]; then echo "  ok   $1"; PASS=$((PASS+1));
  else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi
}

echo "Easel smoke against $BASE"

# 1. landing page
code=$(curl -s -o /tmp/easel-smoke-page.html -w '%{http_code}' --max-time 15 "$BASE/easel/")
[[ "$code" == "200" ]] && grep -qi "easel" /tmp/easel-smoke-page.html; check "GET /easel/ 200 + content" $?

# 2. create board
create=$(curl -s --max-time 15 -X POST "$BASE/api/easel/board" -H 'Content-Type: application/json' -d '{}')
board=$(echo "$create" | grep -o '"id":"el_[a-z0-9]*"' | cut -d'"' -f4)
[[ -n "$board" ]]; check "POST /api/easel/board -> id" $?
[[ -n "$board" ]] || { echo "no board id; aborting"; exit 1; }

# 3. fetch board v1
get1=$(curl -s --max-time 15 "$BASE/api/easel/board/$board")
echo "$get1" | grep -q '"version":1'; check "GET board version 1" $?

# 4. PUT doc (optimistic concurrency)
put1=$(curl -s --max-time 15 -X PUT "$BASE/api/easel/board/$board" -H 'Content-Type: application/json' \
  -d '{"base_version":1,"doc":{"background":"dots","elements":[{"id":"e1","type":"text","x":100,"y":100,"w":300,"h":60,"z":1,"props":{"text":"smoke","size":36}}]}}')
echo "$put1" | grep -q '"version":2'; check "PUT board -> version 2" $?

# 5. stale PUT rejected
put2=$(curl -s -o /tmp/easel-smoke-409.json -w '%{http_code}' --max-time 15 -X PUT "$BASE/api/easel/board/$board" \
  -H 'Content-Type: application/json' -d '{"base_version":1,"doc":{"background":"dots","elements":[]}}')
[[ "$put2" == "409" ]]; check "stale PUT -> 409 version_conflict" $?

# 6. since-poll unchanged
since=$(curl -s --max-time 15 "$BASE/api/easel/board/$board?since=2")
echo "$since" | grep -q '"unchanged":true'; check "GET ?since=2 -> unchanged" $?

# 7. upload 1x1 png
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa75\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82' > /tmp/easel-smoke.png
up=$(curl -s --max-time 20 -X POST "$BASE/api/easel/upload?board=$board" -H 'Content-Type: image/png' --data-binary @/tmp/easel-smoke.png)
src=$(echo "$up" | grep -o '"src":"[^"]*"' | cut -d'"' -f4)
[[ -n "$src" ]]; check "POST upload -> src" $?

# 8. image proxy serves it
if [[ -n "$src" ]]; then
  icode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE$src")
  [[ "$icode" == "200" ]]; check "GET $src -> 200" $?
else
  check "GET image proxy" 1
fi

# 9. agent route wired (bad board -> 404, no session burned)
acode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/api/easel/agent" \
  -H 'Content-Type: application/json' -d '{"board_id":"el_zzzzzzzz","prompt":"x"}')
[[ "$acode" == "404" ]]; check "POST agent (unknown board) -> 404" $?

# 10. stream route guards malformed ids
scode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/api/easel/stream/not-an-id")
[[ "$scode" == "400" ]]; check "GET stream bad id -> 400" $?

echo ""
echo "smoke: $PASS passed, $FAIL failed"
[[ "$FAIL" == "0" ]]
