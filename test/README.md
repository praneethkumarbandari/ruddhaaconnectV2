# Regression Suites — how to run them

Require a real Postgres instance. Nothing here is mocked — every suite
drives either the real `src/lib/*.ts` functions directly, or (for the
Netlify adapter) the actual esbuild-bundled Netlify Function.

```bash
cd backend
npm install

export DATABASE_URL="postgres://postgres:testpass@localhost:5432/ruddhaa_test"
export JWT_SECRET="test-secret"
export SEED_USERNAME=admin
export SEED_PASSWORD="TestPass123!"

npm run migrate
npx tsx src/db/seed.ts

npm run test:phase2       # 73 tests — core accounting engine + patches
npm run test:bankimport   # 22 tests — Bank Import Engine, including the
                           #   architectural proof that imported transactions
                           #   post through the same engine as manual ones
npx tsx test/netlify-function-adapter.ts   # 9 tests — invokes the real,
                           #   esbuild-bundled Netlify Function directly
                           #   with Lambda-style events, including a real
                           #   multipart file upload
```

- Each suite exits 0 if every test passes, non-zero otherwise.
- Prints PASS/FAIL per test, then a summary with diagnostic messages for any failures.
- Safe to re-run against a database that already has data — test fixtures are suffixed with a run timestamp and reconciliation checks are scoped to each run's own records.
- `test:phase2` and `test:bankimport` don't need the HTTP server or JWT auth running — they call the library functions directly, the same functions every route ultimately calls. `netlify-function-adapter.ts` specifically exercises the HTTP/Lambda-event layer that the other two don't.
- There is currently no dedicated automated suite for Project Management — it was verified through live, hand-computed financial reconciliation and a full 12-step end-to-end workflow instead. Worth adding a `test/project-regression.ts` following the same pattern before a production pilot.

Send the full console output back for review — pass or fail.
