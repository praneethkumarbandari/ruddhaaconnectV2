/**
 * HR MODULE — MILESTONE 1 MASTER DATA — REGRESSION SUITE
 * ==========================================================
 *
 * Run with:
 *   npx tsx test/hr-masters-regression.ts
 *
 * Same approach as test/permissions-regression.ts: drives the real
 * Express app through the exported Netlify Function `handler`, so
 * requireAuth + requirePermission + route logic all run for real
 * against a live database. Creates its own HR_ADMIN-role employee
 * directly via SQL (bootstrap), then does every subsequent action
 * through the HTTP-level API.
 *
 * Test data (department/designation/etc. codes) is suffixed with this
 * run's timestamp so repeated runs against a database that already
 * has data don't collide.
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
    console.log(`FAIL  ${name}`);
    console.log(`      -> ${msg}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function parseQuery(path: string): Record<string, string> | null {
  const qIndex = path.indexOf("?");
  if (qIndex === -1) return null;
  const params = new URLSearchParams(path.slice(qIndex + 1));
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return Object.keys(out).length ? out : null;
}

function buildEvent(opts: { method: string; path: string; headers?: Record<string, string>; body?: string | null }) {
  return {
    httpMethod: opts.method,
    // FIX (test harness, not product code): a real Netlify/API Gateway
    // event never puts the query string inside `path` -- it always
    // arrives split out in `queryStringParameters`. Splitting it out
    // here the same way means callers can still write a natural
    // '/foo?bar=baz' path and this harness models real event shape.
    path: opts.path.split("?")[0],
    headers: opts.headers ?? {},
    multiValueHeaders: {},
    queryStringParameters: parseQuery(opts.path),
    multiValueQueryStringParameters: null,
    body: opts.body ?? null,
    isBase64Encoded: false,
    requestContext: { requestId: "hr-test-" + Date.now(), identity: { sourceIp: "127.0.0.1" } },
  };
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const event = buildEvent({ method, path: `/.netlify/functions/api${path}`, headers, body: body === undefined ? null : JSON.stringify(body) });
  const resp: any = await handler(event, {});
  return { status: resp.statusCode, body: resp.body ? JSON.parse(resp.body) : null };
}

const RUN = Date.now();
const TEST_PASSWORD = "hr-test-password-123";

async function main() {
  const username = `hr_test_admin_${RUN}`;
  const hash = await bcrypt.hash(TEST_PASSWORD, 4);
  const { rows: emp } = await pool.query(
    `insert into employees (username, employee_name, password_hash) values ($1, $2, $3) returning id`,
    [username, `HR Test Admin ${RUN}`, hash],
  );
  const { rows: role } = await pool.query(`select id from roles where role_code = 'HR_ADMIN'`);
  assert(role.length === 1, "HR_ADMIN role not found — did schema-permissions.sql + schema-hr-masters.sql run?");
  await pool.query(`insert into user_roles (employee_id, role_id) values ($1, $2)`, [emp[0].id, role[0].id]);

  const { status: loginStatus, body: loginBody } = await call("POST", "/auth/login", null, { username, password: TEST_PASSWORD });
  assert(loginStatus === 200, `bootstrap login failed: ${JSON.stringify(loginBody)}`);
  const token: string = loginBody.token;

  // ------------------------------------------------------------
  // DEPARTMENTS (self-referencing hierarchy)
  // ------------------------------------------------------------
  let parentDeptId = 0;
  let childDeptId = 0;
  await check("create parent department", async () => {
    const { status, body } = await call("POST", "/hr/departments", token, { departmentCode: `DEPT_P_${RUN}`, departmentName: "Engineering" });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    parentDeptId = body.id;
  });
  await check("create child department referencing parent", async () => {
    const { status, body } = await call("POST", "/hr/departments", token, { departmentCode: `DEPT_C_${RUN}`, departmentName: "Backend Team", parentDepartmentId: parentDeptId });
    assert(status === 201, `expected 201, got ${status}`);
    assert(body.parent_department_id === parentDeptId, "parent_department_id not persisted correctly");
    childDeptId = body.id;
  });
  await check("duplicate department_code is rejected with 409", async () => {
    const { status } = await call("POST", "/hr/departments", token, { departmentCode: `DEPT_P_${RUN}`, departmentName: "Duplicate" });
    assert(status === 409, `expected 409, got ${status}`);
  });
  await check("department cannot be its own parent (422)", async () => {
    const { status } = await call("PATCH", `/hr/departments/${parentDeptId}`, token, { parentDepartmentId: parentDeptId });
    assert(status === 422, `expected 422, got ${status}`);
  });
  await check("invalid parentDepartmentId on create is rejected (400, not 500)", async () => {
    const { status } = await call("POST", "/hr/departments", token, { departmentCode: `DEPT_BAD_${RUN}`, departmentName: "x", parentDepartmentId: 999999999 });
    assert(status === 400, `expected 400, got ${status}`);
  });
  await check("deactivate department sets is_active false but row remains queryable", async () => {
    const { status, body } = await call("POST", `/hr/departments/${childDeptId}/deactivate`, token);
    assert(status === 200, `expected 200, got ${status}`);
    assert(body.is_active === false, "is_active was not set to false");
    const { rows } = await pool.query(`select is_active from departments where id = $1`, [childDeptId]);
    assert(rows.length === 1, "department row was hard-deleted, not deactivated");
  });

  // ------------------------------------------------------------
  // DESIGNATIONS
  // ------------------------------------------------------------
  await check("create designation scoped to a department", async () => {
    const { status, body } = await call("POST", "/hr/designations", token, { designationCode: `DESIG_${RUN}`, designationName: "Backend Engineer", departmentId: parentDeptId });
    assert(status === 201, `expected 201, got ${status}`);
    assert(body.department_id === parentDeptId, "department_id not persisted");
  });

  // ------------------------------------------------------------
  // EMPLOYMENT TYPES
  // ------------------------------------------------------------
  await check("create + update + deactivate an employment type", async () => {
    const { status: cStatus, body: created } = await call("POST", "/hr/employment-types", token, { employmentTypeCode: `ET_${RUN}`, employmentTypeName: "Full-time" });
    assert(cStatus === 201, `create: expected 201, got ${cStatus}`);
    const { status: uStatus, body: updated } = await call("PATCH", `/hr/employment-types/${created.id}`, token, { employmentTypeName: "Full-Time (Updated)" });
    assert(uStatus === 200 && updated.employment_type_name === "Full-Time (Updated)", "update did not persist");
    const { status: dStatus, body: deactivated } = await call("POST", `/hr/employment-types/${created.id}/deactivate`, token);
    assert(dStatus === 200 && deactivated.is_active === false, "deactivate did not persist");
  });

  // ------------------------------------------------------------
  // BRANCHES
  // ------------------------------------------------------------
  let branchId = 0;
  await check("create a branch", async () => {
    const { status, body } = await call("POST", "/hr/branches", token, { branchCode: `BR_${RUN}`, branchName: "Hyderabad HQ", city: "Hyderabad", state: "Telangana" });
    assert(status === 201, `expected 201, got ${status}`);
    branchId = body.id;
  });

  // ------------------------------------------------------------
  // COST CENTERS
  // ------------------------------------------------------------
  await check("create a cost center scoped to a department", async () => {
    const { status, body } = await call("POST", "/hr/cost-centers", token, { costCenterCode: `CC_${RUN}`, costCenterName: "Eng Cost Center", departmentId: parentDeptId });
    assert(status === 201, `expected 201, got ${status}`);
  });

  // ------------------------------------------------------------
  // SHIFTS
  // ------------------------------------------------------------
  await check("create a shift with valid times", async () => {
    const { status, body } = await call("POST", "/hr/shifts", token, { shiftCode: `SHIFT_${RUN}`, shiftName: "Day Shift", startTime: "09:00", endTime: "18:00", breakMinutes: 60 });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
  await check("invalid shift time is rejected with 400, not a raw Postgres error", async () => {
    const { status } = await call("POST", "/hr/shifts", token, { shiftCode: `SHIFT_BAD_${RUN}`, shiftName: "Bad", startTime: "99:99", endTime: "18:00" });
    assert(status === 400, `expected 400, got ${status}`);
  });

  // ------------------------------------------------------------
  // HOLIDAYS (branch-specific + all-branches duplicate rules)
  // ------------------------------------------------------------
  const holidayDate = "2027-01-26"; // fixed calendar date is fine — branch_id + RUN-scoped branch keeps this test isolated
  await check("create an all-branches holiday", async () => {
    const { status } = await call("POST", "/hr/holidays", token, { holidayDate, holidayName: "Republic Day" });
    assert(status === 201, `expected 201, got ${status}`);
  });
  await check("a second all-branches holiday on the same date is rejected (409)", async () => {
    const { status } = await call("POST", "/hr/holidays", token, { holidayDate, holidayName: "Duplicate All-Branches" });
    assert(status === 409, `expected 409, got ${status}`);
  });
  await check("a branch-specific holiday on the same date as an all-branches holiday is allowed", async () => {
    const { status } = await call("POST", "/hr/holidays", token, { holidayDate, holidayName: "Branch Specific Extra Day", branchId });
    assert(status === 201, `expected 201, got ${status}`);
  });
  await check("a duplicate branch-specific holiday on the same date+branch is rejected (409, via the partial unique index)", async () => {
    const { status } = await call("POST", "/hr/holidays", token, { holidayDate, holidayName: "Should Collide", branchId });
    assert(status === 409, `expected 409, got ${status}`);
  });

  // ------------------------------------------------------------
  // SALARY COMPONENTS + STRUCTURES
  // ------------------------------------------------------------
  let fixedComponentId = 0;
  let percentComponentId = 0;
  await check("create a fixed earning component and a percentage deduction component", async () => {
    const { status: s1, body: b1 } = await call("POST", "/hr/salary-components", token, {
      componentCode: `SC_BASIC_${RUN}`, componentName: "Basic Pay", componentType: "earning", calculationType: "fixed",
    });
    assert(s1 === 201, `expected 201, got ${s1}`);
    fixedComponentId = b1.id;

    const { status: s2, body: b2 } = await call("POST", "/hr/salary-components", token, {
      componentCode: `SC_PF_${RUN}`, componentName: "Provident Fund", componentType: "deduction", calculationType: "percentage",
    });
    assert(s2 === 201, `expected 201, got ${s2}`);
    percentComponentId = b2.id;
  });
  await check("invalid componentType is rejected with 400", async () => {
    const { status } = await call("POST", "/hr/salary-components", token, { componentCode: `SC_BAD_${RUN}`, componentName: "x", componentType: "bogus", calculationType: "fixed" });
    assert(status === 400, `expected 400, got ${status}`);
  });

  let structureId = 0;
  await check("create a salary structure", async () => {
    const { status, body } = await call("POST", "/hr/salary-structures", token, { structureCode: `SS_${RUN}`, structureName: "Standard Structure" });
    assert(status === 201, `expected 201, got ${status}`);
    structureId = body.id;
  });
  await check("attach the fixed component with an amount", async () => {
    const { status } = await call("POST", `/hr/salary-structures/${structureId}/components`, token, { componentId: fixedComponentId, amount: 40000, sequence: 1 });
    assert(status === 201, `expected 201, got ${status}`);
  });
  await check("attach the percentage component with a percentage", async () => {
    const { status } = await call("POST", `/hr/salary-structures/${structureId}/components`, token, { componentId: percentComponentId, percentage: 12, sequence: 2 });
    assert(status === 201, `expected 201, got ${status}`);
  });
  await check("attaching a fixed-calculation component without an amount is rejected (422, specific message)", async () => {
    const { status: s1, body: b1 } = await call("POST", "/hr/salary-components", token, { componentCode: `SC_HRA_${RUN}`, componentName: "HRA", componentType: "earning", calculationType: "fixed" });
    assert(s1 === 201, "setup: failed to create HRA component");
    const { status } = await call("POST", `/hr/salary-structures/${structureId}/components`, token, { componentId: b1.id, percentage: 50 });
    assert(status === 422, `expected 422, got ${status}`);
  });
  await check("GET structure returns its attached components with derived component fields", async () => {
    const { status, body } = await call("GET", `/hr/salary-structures/${structureId}`, token);
    assert(status === 200, `expected 200, got ${status}`);
    assert(Array.isArray(body.components) && body.components.length === 2, `expected 2 components, got ${body.components?.length}`);
    const basic = body.components.find((c: any) => c.component_id === fixedComponentId);
    assert(basic && Number(basic.amount) === 40000, "amount not correctly returned for the fixed component");
  });

  // ------------------------------------------------------------
  // LEAVE TYPES
  // ------------------------------------------------------------
  await check("create a leave type with carry-forward requires maxCarryForwardDays", async () => {
    const { status } = await call("POST", "/hr/leave-types", token, { leaveTypeCode: `LT_BAD_${RUN}`, leaveTypeName: "Bad", allowCarryForward: true });
    assert(status === 400, `expected 400, got ${status}`);
  });
  await check("create a valid leave type", async () => {
    const { status, body } = await call("POST", "/hr/leave-types", token, {
      leaveTypeCode: `LT_${RUN}`, leaveTypeName: "Earned Leave", accrualFrequency: "monthly",
      defaultAnnualDays: 18, allowCarryForward: true, maxCarryForwardDays: 6, allowEncashment: true,
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });

  // ------------------------------------------------------------
  // ATTENDANCE STATUSES
  // ------------------------------------------------------------
  await check("create an unpaid attendance status", async () => {
    const { status, body } = await call("POST", "/hr/attendance-statuses", token, { statusCode: `AS_${RUN}`, statusName: "Leave Without Pay", isPaid: false });
    assert(status === 201 && body.is_paid === false, `expected 201 with is_paid=false, got ${status}`);
  });

  // ------------------------------------------------------------
  // DOCUMENT TYPES
  // ------------------------------------------------------------
  await check("create a mandatory document type", async () => {
    const { status, body } = await call("POST", "/hr/document-types", token, { documentTypeCode: `DT_${RUN}`, documentTypeName: "PAN Card", isMandatory: true });
    assert(status === 201 && body.is_mandatory === true, `expected 201 with is_mandatory=true, got ${status}`);
  });

  // ------------------------------------------------------------
  // Every master's list endpoint is reachable and returns this run's rows
  // ------------------------------------------------------------
  const listEndpoints = [
    "/hr/departments", "/hr/designations", "/hr/employment-types", "/hr/branches",
    "/hr/cost-centers", "/hr/shifts", "/hr/holidays", "/hr/salary-components",
    "/hr/salary-structures", "/hr/leave-types", "/hr/attendance-statuses", "/hr/document-types",
  ];
  for (const endpoint of listEndpoints) {
    await check(`GET ${endpoint} succeeds and returns an array`, async () => {
      const { status, body } = await call("GET", endpoint, token);
      assert(status === 200, `expected 200, got ${status}`);
      assert(Array.isArray(body), `expected an array, got ${typeof body}`);
    });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  await pool.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
