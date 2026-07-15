#!/usr/bin/env bash
# Payroll: create run -> process -> preview -> lock -> post accrual -> post payment -> payslip.
# Uses sample employees and attendance from load-sample-data.ts.
# Note: load-sample-data.ts already creates and posts a run for last
# month. This script creates a NEW run for the current month to keep
# the two paths independent.
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
USER="${SEED_USERNAME:-admin}"
PASS="${SEED_PASSWORD:?Set SEED_PASSWORD}"

TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" -H "content-type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
AUTH=(-H "authorization: Bearer $TOKEN")

# Current month boundaries
MONTH_START=$(date +%Y-%m-01)
# Last day of current month
MONTH_END=$(date -d "$(date +%Y-%m-01) +1 month -1 day" +%Y-%m-%d 2>/dev/null \
  || python3 -c "import datetime; d=datetime.date.today(); import calendar; print(d.replace(day=calendar.monthrange(d.year,d.month)[1]))")

echo "== Create payroll run ($MONTH_START .. $MONTH_END) =="
RUN=$(curl -sf -X POST "${AUTH[@]}" -H "content-type: application/json" "$BASE/api/payroll/runs" -d "{
  \"runType\": \"monthly\", \"periodStart\": \"$MONTH_START\", \"periodEnd\": \"$MONTH_END\"
}")
RUN_ID=$(echo "$RUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "Created run $RUN_ID"

echo "== Process (calculate payroll lines for all eligible employees) =="
curl -sf -X POST "${AUTH[@]}" "$BASE/api/payroll/runs/$RUN_ID/process" | python3 -m json.tool

echo "== Preview journal entries before posting =="
curl -sf "${AUTH[@]}" "$BASE/api/payroll/posting/$RUN_ID/preview" | python3 -m json.tool

echo "== Lock run =="
curl -sf -X POST "${AUTH[@]}" "$BASE/api/payroll/runs/$RUN_ID/lock" | python3 -m json.tool

echo "== Post accrual journal entry (Salary Expense Dr / Salary Payable Cr) =="
curl -sf -X POST "${AUTH[@]}" "$BASE/api/payroll/posting/$RUN_ID/post" | python3 -m json.tool

echo "== Post payment journal entry (Salary Payable Dr / Bank Cr) =="
curl -sf -X POST "${AUTH[@]}" "$BASE/api/payroll/posting/$RUN_ID/pay" | python3 -m json.tool

echo "== Read payroll run (confirm status = posted) =="
curl -sf "${AUTH[@]}" "$BASE/api/payroll/runs/$RUN_ID" | python3 -c \
  'import sys,json;r=json.load(sys.stdin);print("status:",r.get("status"),"accrual_je_id:",r.get("accrual_journal_entry_id"),"payment_je_id:",r.get("payment_journal_entry_id"))'

echo "== Get payroll register (line-level breakdown) =="
curl -sf "${AUTH[@]}" "$BASE/api/payroll/reports/register/$RUN_ID" | python3 -m json.tool | head -60

echo "== Get salary register =="
curl -sf "${AUTH[@]}" "$BASE/api/payroll/reports/salary-register/$RUN_ID" | python3 -m json.tool | head -40

echo "== Get bank transfer list =="
curl -sf "${AUTH[@]}" "$BASE/api/payroll/reports/bank-transfer/$RUN_ID" | python3 -m json.tool | head -20

echo ""
echo "== Payslip (needs the payroll_lines.id, not employee id) =="
LINE_ID=$(curl -sf "${AUTH[@]}" "$BASE/api/payroll/reports/register/$RUN_ID" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["id"]) if d else print("no lines")' 2>/dev/null)
if [ -n "$LINE_ID" ] && [ "$LINE_ID" != "no lines" ]; then
  curl -sf "${AUTH[@]}" "$BASE/api/payroll/reports/payslip/$LINE_ID" | python3 -m json.tool
fi
