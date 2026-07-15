import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";

/**
 * ONE-TIME / OCCASIONAL SETUP ENDPOINTS
 * ================================================
 * Exists only because this deployment has no way to run a local
 * script (no Node available locally) — both routes below do over
 * HTTP what would otherwise need a local `psql`/`tsx` session.
 *
 * FIX (architecture pivot — schema-per-tenant, not shared-tables +
 * RLS): both routes rewritten. The old model looked up/created rows
 * in shared tables with a tenant_id column; the real, consistently-
 * stated requirement was separate tables per company, so both routes
 * now operate on real Postgres schemas (see schema-per-tenant-
 * architecture.sql's create_tenant_schema() function) instead.
 *
 * Two distinct jobs, kept as two routes rather than merged, because
 * they genuinely do different things now:
 *   - /onboard-tenant: brand-new company. Creates its schema (all 93
 *     tables, cloned structure, independent sequences, real foreign
 *     keys — see create_tenant_schema()), seeds its own standard
 *     Chart of Accounts and financial year, creates its first admin.
 *   - /bootstrap-admin: an EXISTING schema (most commonly "test",
 *     which already has the pre-pivot data moved into it via schema-
 *     migrate-existing-to-test-schema.sql, and already has its own
 *     Chart of Accounts/financial year) that just needs an admin
 *     login created or reset. Does NOT create a schema or seed
 *     accounting data — refuses if the schema doesn't already exist,
 *     rather than silently creating a half-provisioned one.
 *
 * Safety, both routes:
 *   1. checkSetupGate() below — SETUP_ENABLED must be "true" AND
 *      SETUP_TOKEN must match. Toggle SETUP_ENABLED in Netlify only
 *      while actively about to use one of these, remove it after —
 *      no code change or redeploy needed to turn access on/off.
 *   2. /bootstrap-admin additionally refuses outright if the target
 *      schema already has any employee — can only ever create the
 *      first admin for that schema, never touch anything after.
 *      /onboard-tenant deliberately has no equivalent refusal — its
 *      whole purpose is running again for the 2nd, 3rd, 4th company.
 */

const router = Router();

/**
 * Shared by both routes. Returns an error message if the request
 * should be rejected, or null if it's allowed to proceed. Checked in
 * this order: SETUP_ENABLED must be exactly "true" (the everyday
 * on/off switch you'll actually toggle), then SETUP_TOKEN must be set
 * and match (the anti-stranger-race secret).
 */
function checkSetupGate(req: Request): { status: number; error: string } | null {
  if (process.env.SETUP_ENABLED !== "true") {
    return {
      status: 403,
      error: "Setup endpoints are currently disabled. Set SETUP_ENABLED=true in Netlify's environment variables and redeploy to re-enable, then remove it again once you're done.",
    };
  }
  const setupToken = process.env.SETUP_TOKEN;
  if (!setupToken) {
    return { status: 500, error: "SETUP_TOKEN is not set on the server. Set it before using this endpoint." };
  }
  if (req.query.token !== setupToken) {
    return { status: 403, error: "Invalid or missing setup token." };
  }
  return null;
}

const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * ONBOARD A NEW TENANT (brand-new company/schema)
 * ================================================
 * body: { schemaName, companyName, username, password }
 *
 * schemaName becomes both the Postgres schema name AND (by
 * convention, see lib/schema-resolver.ts) the subdomain this company
 * logs in on — e.g. schemaName "dwaraka" -> dwaraka.ruddhaaconnect.in.
 */
router.post("/onboard-tenant", asyncHandler(async (req: Request, res: Response) => {
  const gateError = checkSetupGate(req);
  if (gateError) {
    return res.status(gateError.status).json({ error: gateError.error });
  }

  const schemaName = (req.body?.schemaName as string || "").trim().toLowerCase();
  const companyName = (req.body?.companyName as string || "").trim();
  const username = (req.body?.username as string || "").trim();
  const password = req.body?.password as string;

  if (!schemaName || !SCHEMA_NAME_PATTERN.test(schemaName)) {
    return res.status(400).json({ error: "schemaName is required and must be lowercase letters/numbers/underscores, starting with a letter (e.g. 'dwaraka')." });
  }
  if (!companyName) return res.status(400).json({ error: "companyName is required." });
  if (!username) return res.status(400).json({ error: "username is required." });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "A password of at least 8 characters is required." });
  }

  const { rows: existingSchema } = await pool.query(
    `select 1 from information_schema.schemata where schema_name = $1`,
    [schemaName],
  );
  if (existingSchema.length > 0) {
    return res.status(409).json({ error: `Schema "${schemaName}" already exists.` });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    // Creates the schema and clones all 93 per-tenant tables into it —
    // see schema-per-tenant-architecture.sql for exactly what this
    // does (structure cloning, independent sequences, real foreign
    // keys, tenant_id column dropped since it's vestigial now).
    await client.query(`select create_tenant_schema($1)`, [schemaName]);

    // Lightweight cross-cutting registry entry — no longer an
    // isolation mechanism (the schema itself is), just bookkeeping
    // (e.g. this is what lib/google-drive.ts's per-company folder
    // mapping keys off).
    await client.query(
      `insert into tenants (tenant_code, tenant_name) values ($1, $2) on conflict (tenant_code) do nothing`,
      [schemaName, companyName],
    );

    // Standard system Chart of Accounts — same 14 accounts every
    // company gets, per schema.sql / schema-phase2.sql's original
    // seed. Explicitly schema-qualified (not relying on search_path)
    // because this script runs before any tenant-context middleware
    // ever touches this connection.
    const standardAccounts: Array<[string, string, string]> = [
      ["1000", "Cash", "asset"],
      ["1100", "Bank", "asset"],
      ["1161", "Input CGST", "asset"],
      ["1162", "Input SGST", "asset"],
      ["1163", "Input IGST", "asset"],
      ["1200", "Trade Debtors", "asset"],
      ["2100", "Trade Creditors", "liability"],
      ["2151", "Output CGST", "liability"],
      ["2152", "Output SGST", "liability"],
      ["2153", "Output IGST", "liability"],
      ["3000", "Capital", "equity"],
      ["4000", "Sales", "income"],
      ["5000", "Purchases", "expense"],
      ["5900", "Miscellaneous Expense", "expense"],
    ];
    for (const [code, name, type] of standardAccounts) {
      await client.query(
        `insert into ${schemaName}.chart_of_accounts (account_code, account_name, account_type, is_system) values ($1, $2, $3, true)`,
        [code, name, type],
      );
    }

    const today = new Date();
    const fyStartYear = today.getUTCMonth() >= 3 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
    const fyCode = `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;
    await client.query(
      `insert into ${schemaName}.financial_years (code, start_date, end_date) values ($1, $2, $3)`,
      [fyCode, `${fyStartYear}-04-01`, `${fyStartYear + 1}-03-31`],
    );

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows: empRows } = await client.query(
      `insert into ${schemaName}.employees (username, employee_name, password_hash, role) values ($1, $2, $3, 'super_admin') returning id`,
      [username, "Administrator", passwordHash],
    );
    const employeeId = empRows[0].id;

    // Roles/permissions stay shared (public.roles), not cloned per
    // schema — this insert reaches across schemas deliberately: the
    // grant lives in this company's own user_roles, but the role
    // definition itself (SYSTEM_ADMIN) is the one shared, common
    // definition every company's admin gets.
    let roleAssigned = false;
    try {
      const result = await client.query(
        `insert into ${schemaName}.user_roles (employee_id, role_id)
         select $1, id from public.roles where role_code = 'SYSTEM_ADMIN'
         on conflict (employee_id, role_id) do nothing`,
        [employeeId],
      );
      roleAssigned = (result.rowCount ?? 0) > 0;
    } catch {
      // RBAC tables not migrated on this environment — non-fatal.
    }

    await client.query("commit");

    return res.status(201).json({
      message: `Onboarded "${companyName}" as schema "${schemaName}" with admin "${username}".`,
      schemaName,
      subdomain: `${schemaName}.ruddhaaconnect.in`,
      employeeId,
      rbacRoleAssigned: roleAssigned,
      financialYear: fyCode,
      chartOfAccountsSeeded: standardAccounts.length,
    });
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * BOOTSTRAP (OR RESET) AN ADMIN INSIDE AN EXISTING SCHEMA
 * ================================================
 * body: { schemaName, username, password }
 *
 * Does NOT create a schema or seed Chart of Accounts/financial year —
 * refuses if the schema doesn't already exist. Use /onboard-tenant
 * for a genuinely brand-new company; use this one for "test" (which
 * already has the pre-pivot data migrated into it) or for re-creating
 * an admin login on any schema that somehow ended up with none.
 */
router.post("/bootstrap-admin", asyncHandler(async (req: Request, res: Response) => {
  const gateError = checkSetupGate(req);
  if (gateError) {
    return res.status(gateError.status).json({ error: gateError.error });
  }

  const schemaName = (req.body?.schemaName as string || "test").trim().toLowerCase();
  const username = (req.body?.username as string) || "admin";
  const password = req.body?.password as string;

  if (!SCHEMA_NAME_PATTERN.test(schemaName)) {
    return res.status(400).json({ error: "schemaName must be lowercase letters/numbers/underscores, starting with a letter." });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "A password of at least 8 characters is required in the request body." });
  }

  const { rows: schemaExists } = await pool.query(
    `select 1 from information_schema.schemata where schema_name = $1`,
    [schemaName],
  );
  if (schemaExists.length === 0) {
    return res.status(404).json({
      error: `Schema "${schemaName}" does not exist. Use /onboard-tenant to create a brand-new company, or run schema-migrate-existing-to-test-schema.sql first if this should be "test".`,
    });
  }

  const { rows: existing } = await pool.query(`select count(*)::int as count from ${schemaName}.employees`);
  if (existing[0].count > 0) {
    return res.status(409).json({
      error: `Setup already complete for schema "${schemaName}" — an employee already exists there. This endpoint refuses to run again for the same schema.`,
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `insert into ${schemaName}.employees (username, employee_name, password_hash, role) values ($1, $2, $3, 'super_admin') returning id`,
    [username, "Administrator", passwordHash],
  );
  const employeeId = rows[0].id;

  let roleAssigned = false;
  try {
    const result = await pool.query(
      `insert into ${schemaName}.user_roles (employee_id, role_id)
       select $1, id from public.roles where role_code = 'SYSTEM_ADMIN'
       on conflict (employee_id, role_id) do nothing`,
      [employeeId],
    );
    roleAssigned = (result.rowCount ?? 0) > 0;
  } catch {
    // RBAC tables not migrated — non-fatal.
  }

  return res.status(201).json({
    message: `Created employee "${username}" as super_admin in schema "${schemaName}".`,
    schemaName,
    subdomain: `${schemaName}.ruddhaaconnect.in`,
    employeeId,
    rbacRoleAssigned: roleAssigned,
  });
}));

export default router;
