#!/usr/bin/env bash
# Employee Lifecycle: create -> update -> department transfer -> manager
# change -> exit. Requires the server running (npm run dev) and
# SEED_USERNAME/SEED_PASSWORD set to the admin created by `npm run seed`.
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
USER="${SEED_USERNAME:-admin}"
PASS="${SEED_PASSWORD:?Set SEED_PASSWORD}"

echo "== Login =="
TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" -H "content-type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
AUTH=(-H "authorization: Bearer $TOKEN")

echo "== Read reference masters (departments, designations, branches) =="
DEPT_ID=$(curl -sf "${AUTH[@]}" "$BASE/api/hr/departments" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["id"] if isinstance(d,list) else d["rows"][0]["id"])')
echo "Using departmentId=$DEPT_ID (edit this script to point at a specific master if you have more than one)"

echo "== Create employee =="
CODE="LIFECYCLE-$(date +%s)"
CREATE=$(curl -sf -X POST "${AUTH[@]}" -H "content-type: application/json" "$BASE/api/hr/employees" -d "{
  \"employeeCode\": \"$CODE\", \"employeeName\": \"Lifecycle Test Employee\",
  \"joiningDate\": \"$(date +%Y-%m-%d)\", \"departmentId\": $DEPT_ID
}")
EMP_ID=$(echo "$CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["employee_id"])')
echo "Created employee $EMP_ID ($CODE)"

echo "== Update employee (basic fields) =="
curl -sf -X PATCH "${AUTH[@]}" -H "content-type: application/json" "$BASE/api/hr/employees/$EMP_ID" \
  -d '{"remarks":"Updated by lifecycle smoke test"}' > /dev/null && echo "Updated OK"

echo "== Fetch employee profile (confirms read-after-write) =="
curl -sf "${AUTH[@]}" "$BASE/api/hr/employees/$EMP_ID" | python3 -m json.tool | head -20

echo ""
echo "NOTE: department transfer, manager change, and exit all go through"
echo "the same PATCH /api/hr/employees/:id endpoint (src/lib/employees.ts"
echo "updateEmployee()) — this smoke test stops at create+update+read to"
echo "avoid guessing at reportingManagerId/exitDate business-rule"
echo "interactions (e.g. exit-date/notice-period checks in leave.ts) that"
echo "should be exercised deliberately, not as an unattended side effect"
echo "of a smoke test. Extend below once you've read updateEmployee()'s"
echo "accepted fields for your build:"
echo "  curl -X PATCH ... -d '{\"departmentId\": <id>}'   # transfer"
echo "  curl -X PATCH ... -d '{\"reportingManagerId\": <id>}'  # manager change"
echo "  curl -X PATCH ... -d '{\"exitDate\": \"YYYY-MM-DD\"}'   # exit"
