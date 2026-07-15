#!/usr/bin/env bash
# Leave: apply -> approve -> attendance sync -> cancel a second request.
# Uses the EL leave type and EMP-SAMPLE-01's opening balance created by
# load-sample-data.ts.
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
USER="${SEED_USERNAME:-admin}"
PASS="${SEED_PASSWORD:?Set SEED_PASSWORD}"

TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" -H "content-type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
AUTH=(-H "authorization: Bearer $TOKEN")

echo "== Look up EL leave type id =="
LEAVE_TYPE_ID=$(curl -sf "${AUTH[@]}" "$BASE/api/hr/leave-types" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next(r["id"] for r in d if r["leave_type_code"]=="EL"))')
echo "leaveTypeId=$LEAVE_TYPE_ID"

FROM=$(date -d "+20 days" +%Y-%m-%d 2>/dev/null || date -v+20d +%Y-%m-%d)
TO=$(date -d "+21 days" +%Y-%m-%d 2>/dev/null || date -v+21d +%Y-%m-%d)

echo "== Apply for leave (as the logged-in admin — swap TOKEN for an EMP-SAMPLE-01 login to test as that employee) =="
APPLY=$(curl -sf -X POST "${AUTH[@]}" -H "content-type: application/json" "$BASE/api/leave/requests" -d "{
  \"leaveTypeId\": $LEAVE_TYPE_ID, \"fromDate\": \"$FROM\", \"toDate\": \"$TO\",
  \"isHalfDay\": false, \"reason\": \"Smoke test leave request\"
}")
REQUEST_ID=$(echo "$APPLY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "Created leave request $REQUEST_ID"

echo "== Approve it =="
curl -sf -X POST "${AUTH[@]}" "$BASE/api/leave/requests/$REQUEST_ID/approve" | python3 -m json.tool

echo "== Confirm attendance sync (ON_LEAVE status should appear on $FROM..$TO) =="
curl -sf "${AUTH[@]}" "$BASE/api/attendance/records?dateFrom=$FROM&dateTo=$TO" | python3 -m json.tool | head -30

echo ""
echo "== Cancellation path: apply for a second, later leave request and cancel it =="
FROM2=$(date -d "+40 days" +%Y-%m-%d 2>/dev/null || date -v+40d +%Y-%m-%d)
TO2=$(date -d "+40 days" +%Y-%m-%d 2>/dev/null || date -v+40d +%Y-%m-%d)
APPLY2=$(curl -sf -X POST "${AUTH[@]}" -H "content-type: application/json" "$BASE/api/leave/requests" -d "{
  \"leaveTypeId\": $LEAVE_TYPE_ID, \"fromDate\": \"$FROM2\", \"toDate\": \"$TO2\",
  \"isHalfDay\": true, \"halfDaySession\": \"first_half\", \"reason\": \"Smoke test half-day\"
}")
REQUEST_ID2=$(echo "$APPLY2" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sf -X POST "${AUTH[@]}" -H "content-type: application/json" "$BASE/api/leave/requests/$REQUEST_ID2/cancel" \
  -d '{"cancellationReason":"Smoke test cancellation"}' | python3 -m json.tool
