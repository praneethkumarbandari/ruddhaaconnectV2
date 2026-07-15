#!/usr/bin/env bash
# Attendance Import: upload -> preview -> commit -> read back.
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
USER="${SEED_USERNAME:-admin}"
PASS="${SEED_PASSWORD:?Set SEED_PASSWORD}"
CSV="$(dirname "$0")/../sample-data/sample-attendance-import.csv"

TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" -H "content-type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
AUTH=(-H "authorization: Bearer $TOKEN")

echo "== Preview import (requires EMP-SAMPLE-01/02 from load-sample-data.ts) =="
PREVIEW=$(curl -sf -X POST "${AUTH[@]}" -F "file=@$CSV" "$BASE/api/attendance/import/preview")
BATCH_ID=$(echo "$PREVIEW" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "Batch $BATCH_ID previewed."
echo "$PREVIEW" | python3 -m json.tool | head -30

echo "== Inspect rows before committing =="
curl -sf "${AUTH[@]}" "$BASE/api/attendance/import/$BATCH_ID/rows" | python3 -m json.tool | head -30

echo "== Commit =="
curl -sf -X POST "${AUTH[@]}" "$BASE/api/attendance/import/commit/$BATCH_ID" | python3 -m json.tool

echo "== Read committed records back =="
curl -sf "${AUTH[@]}" "$BASE/api/attendance/records?employeeCode=EMP-SAMPLE-01" | python3 -m json.tool | head -30

echo ""
echo "To exercise the documented edge cases (missing OUT punch, duplicate"
echo "import, locked period), re-run this script a second time unmodified"
echo "(tests duplicate-import handling), or edit sample-attendance-import.csv"
echo "to drop an Out Time value (tests INCOMPLETE classification)."
