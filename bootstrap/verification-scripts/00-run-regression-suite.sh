#!/usr/bin/env bash
# Full engine verification in one command sequence.
# Requires: DATABASE_URL, JWT_SECRET, SEED_USERNAME, SEED_PASSWORD set,
# and a fresh/empty target database.
set -euo pipefail

echo "== 1/5 Install dependencies =="
npm install

echo "== 2/5 Run migrations =="
npm run migrate 2>&1 | tee migration.log

echo "== 3/5 Seed admin user + financial year =="
npm run seed

echo "== 4/5 Load sample dataset =="
npm run seed:sample-data

echo "== 5/5 Run full regression suite =="
npm run test:all 2>&1 | tee test-results.log

echo ""
echo "Done. migration.log and test-results.log are in the repo root."
echo "Next: run the workflow smoke tests in this same directory"
echo "(01- through 06-) against the running server for HTTP-level checks."
