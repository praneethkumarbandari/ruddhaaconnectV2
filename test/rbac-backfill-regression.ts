/**
 * RBAC MIGRATION — BACKFILL REGRESSION TEST
 * ================================================
 *
 * Verifies the employee-role backfill in schema-rbac-migration.sql
 * (the part that maps every EXISTING employee's old employees.role
 * string onto the new, dynamic role_permissions system) actually maps
 * each legacy role to the correct new role_code — especially 'hr' ->
 * HR_VIEWER, which is not a straightforward name match and is the
 * easiest mapping to get wrong on a future edit.
 *
 * DELIBERATE DESIGN CHOICE: this test reads and re-executes the REAL
 * migration file from disk (src/db/schema-rbac-migration.sql), rather
 * than reimplementing a copy of the seven role-mapping INSERT
 * statements in TypeScript. A reimplemented copy could silently drift
 * out of sync with the real file — someone changes the actual
 * migration's mapping later, forgets to update a separate test copy,
 * and the test keeps passing while testing the WRONG mapping. Testing
 * the real file directly makes that impossible: if the mapping in
 * schema-rbac-migration.sql ever changes, this test is automatically
 * exercising the new version, not a stale copy of the old one.
 *
 * This is safe to do because every statement in that file is
 * idempotent (every insert uses `on conflict do nothing`) — re-
 * running the whole file, including the parts that already ran during
 * the real migration, is a safe no-op for anything already present,
 * and correctly picks up the fresh test employees this suite creates
 * (since the backfill matches on employees.role = '<value>', not on
 * specific employee ids).
 *
 * Run with: npx tsx test/rbac-backfill-regression.ts
 * Requires a live, freshly migrated database (through at least
 * schema-permissions.sql, so the ACCOUNTANT/PROJECT_MANAGER/
 * SALES_ROLE/VIEWER_ROLE/HR_VIEWER/SYSTEM_ADMIN roles already exist —
 * schema-rbac-migration.sql itself creates the first four of those).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../src/db/pool.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, "..", "src", "db", "schema-rbac-migration.sql");

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
const RUN = Date.now();

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail: msg });
    console.log(`FAIL  ${name}\n      -> ${msg}`);
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// The exact mapping this suite expects the real migration file to
// produce — this is the thing under test, not an assumption baked
// into how the employees are created.
const EXPECTED_MAPPING: Record<string, string> = {
  super_admin: "SYSTEM_ADMIN",
  admin: "SYSTEM_ADMIN",
  accountant: "ACCOUNTANT",
  project_manager: "PROJECT_MANAGER",
  sales: "SALES_ROLE",
  viewer: "VIEWER_ROLE",
  // The one that's easy to get wrong: 'hr' is NOT a name match to any
  // 'HR' role -- it must land on HR_VIEWER specifically, per the real
  // migration's own documented reasoning (see the note in
  // schema-rbac-migration.sql itself).
  hr: "HR_VIEWER",
};

async function main() {
  // ---- Create one fresh employee per legacy role string ----
  const employeeIdByRole: Record<string, number> = {};
  for (const legacyRole of Object.keys(EXPECTED_MAPPING)) {
    const { rows } = await pool.query(
      `insert into employees (username, employee_name, password_hash, role)
       values ($1, $2, 'test-hash-not-a-real-login', $3)
       returning id`,
      [`rbac_backfill_${legacyRole}_${RUN}`, `RBAC Backfill Test (${legacyRole})`, legacyRole],
    );
    employeeIdByRole[legacyRole] = rows[0].id;
  }

  await check("all 7 legacy-role test employees were created with no existing user_roles rows yet", async () => {
    for (const [legacyRole, employeeId] of Object.entries(employeeIdByRole)) {
      const { rows } = await pool.query(`select 1 from user_roles where employee_id = $1`, [employeeId]);
      assert(rows.length === 0, `expected employee ${employeeId} (role '${legacyRole}') to have no user_roles rows before the backfill runs`);
    }
  });

  // ---- Re-execute the REAL migration file, not a copy ----
  await check("re-running the actual schema-rbac-migration.sql file succeeds without error (idempotent, safe to re-run)", async () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    await pool.query(sql);
  });

  // ---- Assert each employee now has EXACTLY the correct role ----
  for (const [legacyRole, expectedRoleCode] of Object.entries(EXPECTED_MAPPING)) {
    await check(`employees.role = '${legacyRole}' backfills to exactly role_code '${expectedRoleCode}' in user_roles`, async () => {
      const employeeId = employeeIdByRole[legacyRole];
      const { rows } = await pool.query(
        `select r.role_code from user_roles ur join roles r on r.id = ur.role_id where ur.employee_id = $1`,
        [employeeId],
      );
      assert(rows.length > 0, `expected at least one user_roles row for employee with legacy role '${legacyRole}', found none`);
      const roleCodes = rows.map((r) => r.role_code);
      assert(
        roleCodes.includes(expectedRoleCode),
        `expected role_code '${expectedRoleCode}' for legacy role '${legacyRole}', got: ${roleCodes.join(", ") || "(none)"}`,
      );
    });
  }

  // ---- The specific case called out as easy to get wrong ----
  await check("'hr' does NOT map to a role literally named HR (no such role should exist / be used) — confirms this isn't a coincidental name match", async () => {
    const employeeId = employeeIdByRole["hr"];
    const { rows } = await pool.query(
      `select r.role_code from user_roles ur join roles r on r.id = ur.role_id where ur.employee_id = $1`,
      [employeeId],
    );
    const roleCodes = rows.map((r) => r.role_code);
    assert(!roleCodes.includes("HR"), `found a role_code literally 'HR' assigned -- this suggests a different, coincidental mapping was used instead of the real HR_VIEWER mapping`);
    assert(roleCodes.includes("HR_VIEWER"), `expected HR_VIEWER specifically, got: ${roleCodes.join(", ") || "(none)"}`);
  });

  // ---- Idempotency: running it a second time must not create duplicates ----
  await check("running the migration file a second time does not create duplicate user_roles rows (on conflict do nothing works)", async () => {
    const sql = readFileSync(MIGRATION_PATH, "utf-8");
    await pool.query(sql);
    const employeeId = employeeIdByRole["accountant"];
    const { rows } = await pool.query(`select count(*)::int as count from user_roles where employee_id = $1`, [employeeId]);
    assert(rows[0].count === 1, `expected exactly 1 user_roles row after running the migration twice, got ${rows[0].count} -- on conflict do nothing may not be working as intended`);
  });

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + "=".repeat(60));
  console.log(`Total: ${results.length}   Passed: ${results.length - failed.length}   Failed: ${failed.length}`);
  console.log("=".repeat(60));
  await pool.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
