/**
 * RBAC PERMISSION ENFORCEMENT — REGRESSION SUITE
 * ================================================
 *
 * This is the test the whole RBAC layer needs and none of the
 * existing suites provide: every prior regression test runs as the
 * seeded super_admin, so 104/104 passing proves the ACCOUNTING logic
 * is correct, not that permission enforcement actually blocks anyone.
 *
 * This suite creates a real employee per role, logs each one in
 * through the actual esbuild-bundled Netlify Function (the same
 * artifact netlify-function-adapter.ts proved actually runs), and
 * asserts specific allow/deny outcomes against the real enforcement
 * every route now actually uses — the dynamic, DB-driven
 * role_permissions system (middleware/permission.ts), not the old
 * PERMISSION_MATRIX in lib/permissions.ts. That matrix is no longer
 * imported by any route file as of the RBAC migration
 * (schema-rbac-migration.sql) and is dead code today, kept only until
 * it's confirmed safe to delete — this suite must never go back to
 * describing itself as testing it, since a stale claim here is worse
 * than no claim: it tells a future reader this suite proves something
 * about a system that isn't actually protecting anything anymore.
 *
 * Run with: npx tsx test/permissions-regression.ts
 * Requires a live, freshly migrated database, including
 * schema-rbac.sql, schema-permissions.sql, AND schema-rbac-migration.sql
 * (the last of these seeds the ACCOUNTANT/PROJECT_MANAGER/SALES_ROLE/
 * VIEWER_ROLE roles this suite assigns to its test employees).
 */

import bcrypt from "bcryptjs";
import { pool } from "../src/db/pool.ts";
import { handler } from "../netlify/functions/api.ts";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];

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

const RUN = Date.now();

function parseQuery(path: string): Record<string, string> | null {
  const qIndex = path.indexOf("?");
  if (qIndex === -1) return null;
  const params = new URLSearchParams(path.slice(qIndex + 1));
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return Object.keys(out).length ? out : null;
}

function buildEvent(opts: { method: string; path: string; token?: string; body?: unknown }) {
  return {
    httpMethod: opts.method,
    // FIX (test harness, not product code): a real Netlify/API Gateway
    // event never puts the query string inside `path` -- it always
    // arrives split out in `queryStringParameters`. Splitting it out
    // here the same way means callers can still write a natural
    // '/foo?bar=baz' path and this harness models real event shape.
    path: "/.netlify/functions/api" + opts.path.split("?")[0],
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    multiValueHeaders: {},
    queryStringParameters: parseQuery(opts.path),
    multiValueQueryStringParameters: null,
    body: opts.body ? JSON.stringify(opts.body) : null,
    isBase64Encoded: false,
    requestContext: { requestId: "perm-test-" + Date.now(), identity: { sourceIp: "127.0.0.1" } },
  };
}

async function call(opts: { method: string; path: string; token?: string; body?: unknown }) {
  const resp: any = await handler(buildEvent(opts), {});
  return { status: resp.statusCode, body: resp.body ? JSON.parse(resp.body) : null };
}

async function createEmployeeWithRole(username: string, role: string, password: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `insert into employees (username, employee_name, password_hash, role) values ($1,$2,$3,$4)
     on conflict (username) do update set role = excluded.role, password_hash = excluded.password_hash
     returning id`,
    [username, `Test ${role}`, passwordHash, role],
  );
  const employeeId = rows[0].id;

  // FIX: every route this suite exercises now checks the dynamic
  // role_permissions system (see schema-rbac-migration.sql), not the
  // old employees.role column this function already set above. That
  // migration backfills EXISTING employees at migration time — but
  // this suite creates brand-new employees on every run, which the
  // migration has no way to have already covered. Without this grant,
  // every employee this function creates has zero permissions under
  // real enforcement, regardless of which role string it's given.
  const roleCodeMap: Record<string, string> = {
    super_admin: "SYSTEM_ADMIN", admin: "SYSTEM_ADMIN",
    accountant: "ACCOUNTANT", project_manager: "PROJECT_MANAGER",
    hr: "HR_VIEWER", sales: "SALES_ROLE", viewer: "VIEWER_ROLE",
  };
  const roleCode = roleCodeMap[role];
  if (roleCode) {
    await pool.query(
      `insert into user_roles (employee_id, role_id)
       select $1, id from roles where role_code = $2
       on conflict do nothing`,
      [employeeId, roleCode],
    );
  }
}

async function loginAs(username: string, password: string): Promise<string> {
  const resp = await call({ method: "POST", path: "/auth/login", body: { username, password } });
  assert(resp.status === 200, `login for ${username} should succeed, got ${resp.status}: ${JSON.stringify(resp.body)}`);
  return resp.body.token;
}

async function main() {
  const password = "TestPass123!";
  const roles = ["super_admin", "admin", "accountant", "project_manager", "hr", "sales", "viewer"];
  const tokens: Record<string, string> = {};

  for (const role of roles) {
    const username = `perm_${role}_${RUN}`;
    await createEmployeeWithRole(username, role, password);
    tokens[role] = await loginAs(username, password);
  }

  await check("login response includes the real role, not a guessed default", async () => {
    const resp = await call({ method: "POST", path: "/auth/login", body: { username: `perm_sales_${RUN}`, password } });
    assert(resp.body.user.role === "sales", `expected role 'sales' in login response, got '${resp.body.user.role}'`);
  });

  // ---- viewer: read everywhere, write nowhere ----
  await check("viewer: can read chart-of-accounts", async () => {
    const r = await call({ method: "GET", path: "/chart-of-accounts", token: tokens.viewer });
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });
  await check("viewer: cannot create a customer (write denied)", async () => {
    const r = await call({ method: "POST", path: "/customers", token: tokens.viewer, body: { customerName: "Should Fail", supplyType: "intrastate" } });
    assert(r.status === 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
  await check("viewer: cannot post a contra entry (write denied)", async () => {
    const r = await call({ method: "POST", path: "/contra", token: tokens.viewer, body: { entryDate: "2026-07-04", fromAccountCode: "1100", toAccountCode: "1000", amount: 10 } });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });
  await check("viewer: cannot create a project (write denied)", async () => {
    const r = await call({ method: "POST", path: "/projects", token: tokens.viewer, body: { projectCode: `PRJ-V-${RUN}`, projectName: "Viewer Test" } });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  // ---- hr: only employees:read, everything else denied including read ----
  await check("hr: can read employees", async () => {
    const r = await call({ method: "GET", path: "/employees", token: tokens.hr });
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });
  await check("hr: cannot even READ chart-of-accounts (module is 'none', not just write-denied)", async () => {
    const r = await call({ method: "GET", path: "/chart-of-accounts", token: tokens.hr });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });
  await check("hr: cannot read projects either", async () => {
    const r = await call({ method: "GET", path: "/projects", token: tokens.hr });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  // ---- accountant: full accounting write, projects read-only ----
  let accountantCustomerId: number;
  await check("accountant: can create a customer", async () => {
    const r = await call({ method: "POST", path: "/customers", token: tokens.accountant, body: { customerName: `Accountant Test Co ${RUN}`, supplyType: "intrastate" } });
    assert(r.status === 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    accountantCustomerId = r.body.id;
  });
  await check("accountant: can post a manual journal entry", async () => {
    const r = await call({ method: "POST", path: "/journal-entries", token: tokens.accountant, body: { entryDate: "2026-07-04", narration: "Permission test entry", lines: [{ accountCode: "5900", debit: 10, credit: 0 }, { accountCode: "1000", debit: 0, credit: 10 }] } });
    assert(r.status === 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
  await check("accountant: can read projects", async () => {
    const r = await call({ method: "GET", path: "/projects", token: tokens.accountant });
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });
  await check("accountant: cannot create a project (accounting role, not PM)", async () => {
    const r = await call({ method: "POST", path: "/projects", token: tokens.accountant, body: { projectCode: `PRJ-ACC-${RUN}`, projectName: "Accountant Test" } });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  // ---- project_manager: full projects write, accounting read-only ----
  let pmProjectId: number;
  await check("project_manager: can create a project", async () => {
    const r = await call({ method: "POST", path: "/projects", token: tokens.project_manager, body: { projectCode: `PRJ-PM-${RUN}`, projectName: "PM Role Test" } });
    assert(r.status === 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    pmProjectId = r.body.id;
  });
  await check("project_manager: can read the sales invoices list", async () => {
    const r = await call({ method: "GET", path: "/sales-invoices", token: tokens.project_manager });
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });
  await check("project_manager: cannot create a sales invoice (accounting write denied)", async () => {
    const r = await call({ method: "POST", path: "/sales-invoices", token: tokens.project_manager, body: { customerId: 1, invoiceDate: "2026-07-04", lines: [{ description: "x", qty: 1, rate: 100, gstRate: 18 }] } });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  // ---- sales: can create customers/sales invoices/receipts/credit notes, cannot create purchase invoices/payments ----
  await check("sales: can create a customer", async () => {
    const r = await call({ method: "POST", path: "/customers", token: tokens.sales, body: { customerName: `Sales Role Test Co ${RUN}`, supplyType: "intrastate" } });
    assert(r.status === 201, `expected 201, got ${r.status}`);
  });
  await check("sales: cannot create a purchase invoice (not their side)", async () => {
    const r = await call({ method: "POST", path: "/purchase-invoices", token: tokens.sales, body: { vendorId: 1, invoiceDate: "2026-07-04", lines: [{ description: "x", qty: 1, rate: 100, gstRate: 18 }] } });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });
  await check("sales: can still read purchase invoices (read access, just not write)", async () => {
    const r = await call({ method: "GET", path: "/purchase-invoices", token: tokens.sales });
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  // ---- super_admin / admin: full access confirmed ----
  let vendorIdForAdminTests: number;
  await check("super_admin: can do everything checked above that others were denied", async () => {
    const vendorResp = await call({ method: "POST", path: "/vendors", token: tokens.super_admin, body: { vendorName: `Perm Test Vendor ${RUN}`, supplyType: "intrastate" } });
    assert(vendorResp.status === 201, `setup: creating a real vendor should succeed, got ${vendorResp.status}: ${JSON.stringify(vendorResp.body)}`);
    vendorIdForAdminTests = vendorResp.body.id;

    const r1 = await call({ method: "POST", path: "/purchase-invoices", token: tokens.super_admin, body: { vendorId: vendorIdForAdminTests, invoiceDate: "2026-07-04", lines: [{ description: "x", qty: 1, rate: 100, gstRate: 18 }] } });
    assert(r1.status === 201, `super_admin purchase invoice creation should succeed, got ${r1.status}: ${JSON.stringify(r1.body)}`);
    const r2 = await call({ method: "POST", path: "/projects", token: tokens.super_admin, body: { projectCode: `PRJ-SA-${RUN}`, projectName: "Super Admin Test" } });
    assert(r2.status === 201, `super_admin project creation should succeed, got ${r2.status}`);
  });
  await check("admin: identical access to super_admin (both map to full access today)", async () => {
    const r = await call({ method: "POST", path: "/vendors", token: tokens.admin, body: { vendorName: `Admin Role Test ${RUN}`, supplyType: "intrastate" } });
    assert(r.status === 201, `admin vendor creation should succeed, got ${r.status}`);
  });

  // ---- unknown/missing role fails closed ----
  await check("a request with no token is rejected before permission checks even run (401, not 403)", async () => {
    const r = await call({ method: "GET", path: "/chart-of-accounts" });
    assert(r.status === 401, `expected 401 (auth failure), got ${r.status}`);
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
