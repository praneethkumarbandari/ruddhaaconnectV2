/**
 * Run once against a freshly-migrated database:
 *   npx tsx src/db/seed.ts
 *
 * SUPERSEDED: this predates multi-tenancy and requires local Node +
 * a direct DATABASE_URL to run — src/routes/setup.ts's
 * /api/setup/bootstrap-admin (an HTTP endpoint, usable from a
 * browser with no local tooling) is the actual, currently-used way
 * to do this now, and is fully tenant-aware. Kept working rather than
 * deleted since it's still a legitimate option for anyone who does
 * have local Node/psql access and prefers a CLI script.
 *
 * FIX: this script predates tenant_id existing at all on employees/
 * user_roles/financial_years — once schema-multitenancy.sql (regular
 * migrate chain) sets those NOT NULL, every insert here would fail
 * outright. Now assigns everything to the same 'DEFAULT' tenant every
 * other pre-multitenancy row was backfilled to, matching bootstrap-
 * admin's own convention.
 *
 * FIX #2: the financial_years insert used `on conflict (code)`,
 * targeting a unique constraint that no longer exists — schema-
 * financial-years-tenant-scope-fix.sql replaced it with
 * unique(tenant_id, code) so a second tenant isn't blocked from ever
 * using a "2026-27"-style code. The old target doesn't match any
 * constraint post-migration, and Postgres throws on this insert
 * every time, not just on a real conflict.
 *
 * Creates the first employee login, grants it full access under BOTH
 * permission systems this codebase runs side by side, and opens one
 * financial year, so the API is immediately usable without
 * hand-writing SQL. chart_of_accounts is already seeded by schema.sql
 * itself.
 *
 * Two permission systems, both seeded here:
 *   1. employees.role = 'super_admin' — the static role-matrix system
 *      (src/lib/permissions.ts) that Accounting, Bank Import, and
 *      Project Management routes are actually gated by today.
 *   2. user_roles -> SYSTEM_ADMIN — the DB-driven RBAC system
 *      (src/lib/rbac-permissions.ts) that HR, Attendance, Leave, and
 *      Payroll routes are gated by.
 * Dropping either write would leave the seeded admin locked out of
 * whichever module that system doesn't cover, so both run
 * unconditionally rather than picking one.
 *
 * Execution Readiness Sprint note (carried over from the HR module):
 * schema-permissions.sql deliberately does NOT assign SYSTEM_ADMIN to
 * any employee from schema alone — there is no safe automatic choice
 * of "which employee is the admin" at the SQL layer, and that
 * fail-closed default is correct. This script is a different layer: a
 * human has already made that choice explicit by setting
 * SEED_USERNAME/SEED_PASSWORD and choosing to run it, so it is safe
 * for the seed script — and only the seed script — to complete the
 * wiring automatically.
 */
import bcrypt from "bcryptjs";
import { pool } from "./pool.ts";

async function seed() {
  const username = process.env.SEED_USERNAME ?? "admin";
  const password = process.env.SEED_PASSWORD;
  if (!password) {
    throw new Error("Set SEED_PASSWORD before running the seed script.");
  }

  const { rows: tenantRows } = await pool.query(`select id from tenants where tenant_code = 'DEFAULT'`);
  if (tenantRows.length === 0) {
    throw new Error("No 'DEFAULT' tenant found. Run schema-multitenancy.sql (which seeds it) first.");
  }
  const tenantId = tenantRows[0].id;

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `insert into employees (username, employee_name, password_hash, role, tenant_id)
     values ($1, $2, $3, 'super_admin', $4)
     on conflict (tenant_id, username) do update set role = 'super_admin'
     returning id`,
    [username, "Administrator", passwordHash, tenantId],
  );
  const employeeId = rows[0].id;

  // Grant SYSTEM_ADMIN in the RBAC tables too — no-op (with a clear
  // log line) on a database where schema-permissions.sql hasn't been
  // applied yet, since the HR module may not be migrated in every
  // deployment.
  let roleAssigned = false;
  try {
    const result = await pool.query(
      `insert into user_roles (employee_id, role_id, tenant_id)
       select $1, id, $2 from roles where role_code = 'SYSTEM_ADMIN'
       on conflict (employee_id, role_id) do nothing`,
      [employeeId, tenantId],
    );
    roleAssigned = (result.rowCount ?? 0) > 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "Skipped RBAC SYSTEM_ADMIN grant (roles/user_roles tables not present — " +
      "run schema-permissions.sql first if the HR module is part of this deployment).",
    );
  }

  const today = new Date();
  const fyStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1; // Apr–Mar year
  const code = `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;
  await pool.query(
    `insert into financial_years (code, start_date, end_date, tenant_id)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, code) do nothing`,
    [code, `${fyStartYear}-04-01`, `${fyStartYear + 1}-03-31`, tenantId],
  );

  // eslint-disable-next-line no-console
  console.log(
    `Seeded employee "${username}" (id ${employeeId}) as super_admin, ` +
    `${roleAssigned ? "granted" : "already had / RBAC not migrated for"} SYSTEM_ADMIN, ` +
    `and financial year "${code}".`,
  );
  await pool.end();
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
