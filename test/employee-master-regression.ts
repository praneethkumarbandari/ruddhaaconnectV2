/**
 * HR MODULE — MILESTONE 2: EMPLOYEE MASTER & PROFILE — REGRESSION SUITE
 * ==========================================================
 *
 * Run with:
 *   npx tsx test/employee-master-regression.ts
 *
 * Requires schema.sql through schema-hr-employee-master.sql all
 * applied (see package.json "migrate"). Same technique as
 * test/permissions-regression.ts and test/hr-masters-regression.ts:
 * drives the real Netlify Function `handler()` directly — no mocks,
 * no network, exercises requireAuth -> requirePermission -> route ->
 * lib chain against a live database.
 *
 * Creates its own HR_ADMIN and HR_VIEWER bootstrap employees directly
 * via SQL (same bootstrap pattern as the other two new suites), then
 * everything else goes through the real HTTP-level API, including
 * the employees this suite is actually testing (created via
 * POST /api/hr/employees, not inserted directly — the whole point is
 * to prove that endpoint provisions both `employees` and
 * `employee_master` correctly).
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
    requestContext: { requestId: "emp-test-" + Date.now(), identity: { sourceIp: "127.0.0.1" } },
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
const BOOTSTRAP_PASSWORD = "emp-test-password-123";

async function bootstrapEmployee(label: string, roleCode: string): Promise<{ id: number; token: string }> {
  const username = `emp_test_${label}_${RUN}`;
  const hash = await bcrypt.hash(BOOTSTRAP_PASSWORD, 4);
  const { rows } = await pool.query(
    `insert into employees (username, employee_name, password_hash) values ($1, $2, $3) returning id`,
    [username, `Employee Test ${label} ${RUN}`, hash],
  );
  const { rows: role } = await pool.query(`select id from roles where role_code = $1`, [roleCode]);
  assert(role.length === 1, `role ${roleCode} not found`);
  await pool.query(`insert into user_roles (employee_id, role_id) values ($1, $2)`, [rows[0].id, role[0].id]);

  const { status, body } = await call("POST", "/auth/login", null, { username, password: BOOTSTRAP_PASSWORD });
  assert(status === 200, `bootstrap login for ${label} failed: ${JSON.stringify(body)}`);
  return { id: rows[0].id, token: body.token };
}

async function main() {
  const hrAdmin = await bootstrapEmployee("hradmin", "HR_ADMIN");
  const hrViewer = await bootstrapEmployee("hrviewer", "HR_VIEWER");
  const noRole = await bootstrapEmployee("norole", "EMPLOYEE"); // baseline role, no hr.* grants

  // ------------------------------------------------------------
  // Master data this suite's employees will reference. Created
  // directly via SQL rather than through the Milestone 1 HTTP API —
  // that API is already covered by hr-masters-regression.ts; this
  // suite's job is Milestone 2, not re-proving Milestone 1.
  // ------------------------------------------------------------
  const { rows: deptRows } = await pool.query(`insert into departments (department_code, department_name) values ($1,'Engineering') returning id`, [`EMPDEPT_${RUN}`]);
  const departmentId = deptRows[0].id;
  const { rows: desigRows } = await pool.query(`insert into designations (designation_code, designation_name) values ($1,'Engineer') returning id`, [`EMPDESIG_${RUN}`]);
  const designationId = desigRows[0].id;

  // ------------------------------------------------------------
  // CREATE (identity + master provisioned together)
  // ------------------------------------------------------------
  let managerEmployeeId = 0;
  let managerTemporaryPassword = "";
  await check("create a manager-level employee", async () => {
    const { status, body } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `EMP_MGR_${RUN}`, employeeName: "Manager One", email: `mgr_${RUN}@example.test`,
      departmentId, designationId, joiningDate: "2024-01-15",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert(typeof body.temporaryPassword === "string" && body.temporaryPassword.length > 8, "temporaryPassword not returned");
    assert(body.username === `emp_mgr_${RUN}`.toLowerCase(), `username not derived from employeeCode correctly: ${body.username}`);
    managerEmployeeId = body.employee_id;
    managerTemporaryPassword = body.temporaryPassword;
  });

  await check("the newly created employee can actually log in with the returned temporary password", async () => {
    const { status, body } = await call("POST", "/auth/login", null, { username: `emp_mgr_${RUN}`, password: managerTemporaryPassword });
    assert(status === 200 && typeof body.token === "string", `expected a working login, got ${status}: ${JSON.stringify(body)}`);
  });

  let subordinateEmployeeId = 0;
  await check("create a subordinate reporting to the manager", async () => {
    const { status, body } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `EMP_SUB_${RUN}`, employeeName: "Subordinate One",
      departmentId, designationId, reportingManagerId: managerEmployeeId, joiningDate: "2024-06-01",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    subordinateEmployeeId = body.employee_id;
  });

  // ------------------------------------------------------------
  // DUPLICATE PREVENTION
  // ------------------------------------------------------------
  await check("duplicate employeeCode is rejected with 409", async () => {
    const { status } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `EMP_MGR_${RUN}`, employeeName: "Duplicate Attempt", joiningDate: "2024-01-01",
    });
    assert(status === 409, `expected 409, got ${status}`);
  });

  await check("duplicate email is rejected with 409, not a raw DB error", async () => {
    const { status } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `EMP_DUPEMAIL_${RUN}`, employeeName: "Dup Email", email: `mgr_${RUN}@example.test`, joiningDate: "2024-01-01",
    });
    assert(status === 409, `expected 409, got ${status}`);
  });

  // ------------------------------------------------------------
  // INVALID REFERENCES
  // ------------------------------------------------------------
  await check("invalid departmentId is rejected with 400 (via lib validation, not a raw 23503)", async () => {
    const { status, body } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `EMP_BADDEPT_${RUN}`, employeeName: "Bad Dept", departmentId: 999999999, joiningDate: "2024-01-01",
    });
    assert(status === 400 || status === 422, `expected 400/422, got ${status}: ${JSON.stringify(body)}`);
  });

  await check("non-existent reportingManagerId is rejected", async () => {
    const { status } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `EMP_BADMGR_${RUN}`, employeeName: "Bad Manager", reportingManagerId: 999999999, joiningDate: "2024-01-01",
    });
    assert(status === 400 || status === 422, `expected 400/422, got ${status}`);
  });

  // ------------------------------------------------------------
  // HIERARCHY: self-manager and circular detection
  // ------------------------------------------------------------
  await check("an employee cannot be set as their own manager (422)", async () => {
    const { status } = await call("PATCH", `/hr/employees/${managerEmployeeId}`, hrAdmin.token, { reportingManagerId: managerEmployeeId });
    assert(status === 422, `expected 422, got ${status}`);
  });

  await check("circular reporting is detected and rejected (422)", async () => {
    // subordinate already reports to manager. Attempting to make
    // manager report to subordinate would close a 2-node cycle.
    const { status, body } = await call("PATCH", `/hr/employees/${managerEmployeeId}`, hrAdmin.token, { reportingManagerId: subordinateEmployeeId });
    assert(status === 422, `expected 422, got ${status}: ${JSON.stringify(body)}`);
  });

  await check("a 3-node circular chain is also detected", async () => {
    const { status: s1, body: b1 } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `EMP_C_${RUN}`, employeeName: "Chain Employee", reportingManagerId: subordinateEmployeeId, joiningDate: "2024-07-01",
    });
    assert(s1 === 201, "setup: failed to create third employee in chain");
    const chainEmployeeId = b1.employee_id;
    // Now attempt manager -> subordinate -> chainEmployee -> manager
    const { status } = await call("PATCH", `/hr/employees/${managerEmployeeId}`, hrAdmin.token, { reportingManagerId: chainEmployeeId });
    assert(status === 422, `expected 422, got ${status}`);
  });

  // ------------------------------------------------------------
  // STATUS TRANSITIONS
  // ------------------------------------------------------------
  await check("exited status without exitDate is rejected", async () => {
    const { status } = await call("PATCH", `/hr/employees/${subordinateEmployeeId}`, hrAdmin.token, { status: "exited" });
    assert(status === 422, `expected 422, got ${status}`);
  });

  await check("valid status transition (active -> on_notice) succeeds", async () => {
    const { status, body } = await call("PATCH", `/hr/employees/${subordinateEmployeeId}`, hrAdmin.token, { status: "on_notice" });
    assert(status === 200 && body.status === "on_notice", `expected 200/on_notice, got ${status}`);
  });

  await check("exiting with exitDate succeeds and disables login", async () => {
    const { status, body } = await call("PATCH", `/hr/employees/${subordinateEmployeeId}`, hrAdmin.token, { status: "exited", exitDate: "2024-12-31" });
    assert(status === 200 && body.status === "exited", `expected 200/exited, got ${status}`);
    const { rows } = await pool.query(`select is_active from employees where id = $1`, [subordinateEmployeeId]);
    assert(rows[0].is_active === false, "employees.is_active was not set to false on exit");
  });

  await check("transitioning out of 'exited' is rejected (terminal status)", async () => {
    const { status } = await call("PATCH", `/hr/employees/${subordinateEmployeeId}`, hrAdmin.token, { status: "active" });
    assert(status === 422, `expected 422, got ${status}`);
  });

  // ------------------------------------------------------------
  // PERMISSION ENFORCEMENT
  // ------------------------------------------------------------
  await check("employee with no HR role cannot view the employee list (403)", async () => {
    const { status } = await call("GET", "/hr/employees", noRole.token);
    assert(status === 403, `expected 403, got ${status}`);
  });

  await check("HR_VIEWER can view employees but not create them", async () => {
    const { status: viewStatus } = await call("GET", "/hr/employees", hrViewer.token);
    assert(viewStatus === 200, `expected 200, got ${viewStatus}`);
    const { status: createStatus } = await call("POST", "/hr/employees", hrViewer.token, { employeeCode: `SHOULD_FAIL_${RUN}`, employeeName: "x", joiningDate: "2024-01-01" });
    assert(createStatus === 403, `expected 403, got ${createStatus}`);
  });

  await check("HR_VIEWER cannot view sensitive bank details (403) despite having hr.employee.view", async () => {
    const { status } = await call("GET", `/hr/employees/${managerEmployeeId}/bank-details`, hrViewer.token);
    assert(status === 403, `expected 403, got ${status}`);
  });

  await check("HR_ADMIN can view and set sensitive bank details", async () => {
    const { status: setStatus } = await call("PUT", `/hr/employees/${managerEmployeeId}/bank-details`, hrAdmin.token, {
      bankName: "Test Bank", accountNumber: "1234567890", ifscCode: "TEST0001234", accountHolderName: "Manager One",
    });
    assert(setStatus === 200, `expected 200, got ${setStatus}`);
    const { status: getStatus, body } = await call("GET", `/hr/employees/${managerEmployeeId}/bank-details`, hrAdmin.token);
    assert(getStatus === 200 && body.account_number === "1234567890", "bank details not persisted correctly");
  });

  // ------------------------------------------------------------
  // PROFILE UPDATES
  // ------------------------------------------------------------
  await check("set current address", async () => {
    const { status, body } = await call("PUT", `/hr/employees/${managerEmployeeId}/addresses/current`, hrAdmin.token, {
      line1: "123 Test Street", city: "Hyderabad", state: "Telangana", pincode: "500001",
    });
    assert(status === 200 && body.city === "Hyderabad", `expected 200 with city persisted, got ${status}`);
  });

  await check("invalid address type is rejected", async () => {
    const { status } = await call("PUT", `/hr/employees/${managerEmployeeId}/addresses/vacation-home`, hrAdmin.token, { line1: "x" });
    assert(status === 400, `expected 400, got ${status}`);
  });

  await check("set contact details, then duplicate personal email on another employee is rejected", async () => {
    const { status: s1 } = await call("PUT", `/hr/employees/${managerEmployeeId}/contact`, hrAdmin.token, { personalEmail: `personal_${RUN}@example.test` });
    assert(s1 === 200, `expected 200, got ${s1}`);
    const { status: s2 } = await call("PUT", `/hr/employees/${subordinateEmployeeId}/contact`, hrAdmin.token, { personalEmail: `personal_${RUN}@example.test` });
    assert(s2 === 409, `expected 409, got ${s2}`);
  });

  await check("add an emergency contact marked primary, then add a second primary which demotes the first", async () => {
    const { status: s1, body: b1 } = await call("POST", `/hr/employees/${managerEmployeeId}/emergency-contacts`, hrAdmin.token, { contactName: "Contact A", phoneNumber: "9990001111", isPrimary: true });
    assert(s1 === 201, `expected 201, got ${s1}`);
    const { status: s2 } = await call("POST", `/hr/employees/${managerEmployeeId}/emergency-contacts`, hrAdmin.token, { contactName: "Contact B", phoneNumber: "9990002222", isPrimary: true });
    assert(s2 === 201, `expected 201, got ${s2}`);
    const { rows } = await pool.query(`select contact_name, is_primary from employee_emergency_contacts where employee_id = $1 and is_primary = true`, [managerEmployeeId]);
    assert(rows.length === 1 && rows[0].contact_name === "Contact B", "primary demotion did not happen correctly — more than one primary, or wrong one");
  });

  await check("add education, experience, skill, certification records", async () => {
    const edu = await call("POST", `/hr/employees/${managerEmployeeId}/education`, hrAdmin.token, { qualification: "B.Tech", institution: "Test University", yearOfPassing: 2015 });
    assert(edu.status === 201, `education: expected 201, got ${edu.status}`);
    const exp = await call("POST", `/hr/employees/${managerEmployeeId}/experience`, hrAdmin.token, { companyName: "Previous Co", fromDate: "2015-07-01", toDate: "2020-01-01" });
    assert(exp.status === 201, `experience: expected 201, got ${exp.status}`);
    const skill = await call("POST", `/hr/employees/${managerEmployeeId}/skills`, hrAdmin.token, { skillName: "TypeScript", proficiencyLevel: "advanced" });
    assert(skill.status === 201, `skill: expected 201, got ${skill.status}`);
    const cert = await call("POST", `/hr/employees/${managerEmployeeId}/certifications`, hrAdmin.token, { certificationName: "AWS Certified" });
    assert(cert.status === 201, `certification: expected 201, got ${cert.status}`);
  });

  await check("duplicate skill name for the same employee is rejected", async () => {
    const { status } = await call("POST", `/hr/employees/${managerEmployeeId}/skills`, hrAdmin.token, { skillName: "TypeScript", proficiencyLevel: "expert" });
    assert(status === 409, `expected 409, got ${status}`);
  });

  // ------------------------------------------------------------
  // DOCUMENTS
  // ------------------------------------------------------------
  const { rows: docTypeRows } = await pool.query(`insert into document_types (document_type_code, document_type_name) values ($1,'PAN Card') returning id`, [`EMPDOC_${RUN}`]);
  const documentTypeId = docTypeRows[0].id;

  let documentId = 0;
  await check("add a document and verify it", async () => {
    const { status, body } = await call("POST", `/hr/employees/${managerEmployeeId}/documents`, hrAdmin.token, { documentTypeId, documentNumber: "ABCDE1234F" });
    assert(status === 201, `expected 201, got ${status}`);
    documentId = body.id;
    const { status: verifyStatus, body: verified } = await call("POST", `/hr/employees/${managerEmployeeId}/documents/${documentId}/verify`, hrAdmin.token);
    assert(verifyStatus === 200 && verified.is_verified === true, "document verification did not persist");
  });

  await check("invalid documentTypeId is rejected with 400", async () => {
    const { status } = await call("POST", `/hr/employees/${managerEmployeeId}/documents`, hrAdmin.token, { documentTypeId: 999999999 });
    assert(status === 400, `expected 400, got ${status}`);
  });

  await check("HR_VIEWER can view documents but not upload them", async () => {
    const { status: viewStatus } = await call("GET", `/hr/employees/${managerEmployeeId}/documents`, hrViewer.token);
    assert(viewStatus === 200, `expected 200, got ${viewStatus}`);
    const { status: createStatus } = await call("POST", `/hr/employees/${managerEmployeeId}/documents`, hrViewer.token, { documentTypeId });
    assert(createStatus === 403, `expected 403, got ${createStatus}`);
  });

  // ------------------------------------------------------------
  // ASSETS
  // ------------------------------------------------------------
  await check("issue and return an asset", async () => {
    const { status: issueStatus, body: issued } = await call("POST", `/hr/employees/${managerEmployeeId}/assets`, hrAdmin.token, { assetName: "Laptop", assetCode: "LAP-001", issuedDate: "2024-01-20" });
    assert(issueStatus === 201, `expected 201, got ${issueStatus}`);
    const { status: returnStatus, body: returned } = await call("POST", `/hr/employees/${managerEmployeeId}/assets/${issued.id}/return`, hrAdmin.token, { returnedDate: "2024-12-01", conditionNotes: "Good condition" });
    assert(returnStatus === 200 && returned.returned_date, "asset return did not persist");
  });

  // ------------------------------------------------------------
  // SEARCH / LIST / ORG TREE
  // ------------------------------------------------------------
  await check("search finds the created employee by partial name match", async () => {
    const { status, body } = await call("GET", `/hr/employees?search=Manager%20One`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}`);
    assert(body.rows.some((r: any) => r.employee_id === managerEmployeeId), "search did not find the expected employee");
  });

  await check("list filters by department", async () => {
    const { status, body } = await call("GET", `/hr/employees?departmentId=${departmentId}`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}`);
    assert(body.rows.length >= 2, `expected at least the 2 employees created in this department, got ${body.rows.length}`);
  });

  await check("org tree from the manager includes the subordinate", async () => {
    const { status, body } = await call("GET", `/hr/employees/${managerEmployeeId}/org-tree`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}`);
    assert(body.some((r: any) => r.employee_id === subordinateEmployeeId), "org tree did not include the direct report");
  });

  await check("manager chain from the subordinate includes the manager", async () => {
    const { status, body } = await call("GET", `/hr/employees/${subordinateEmployeeId}/manager-chain`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}`);
    assert(body.some((r: any) => r.employee_id === managerEmployeeId), "manager chain did not include the manager");
  });

  // ------------------------------------------------------------
  // BACKWARD COMPATIBILITY — existing modules unaffected
  // ------------------------------------------------------------
  await check("existing HR Milestone 1 masters still work unaffected", async () => {
    const { status } = await call("GET", "/hr/departments", hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}`);
  });

  await check("existing accounting routes still work with no permission required beyond a valid JWT", async () => {
    const { status } = await call("GET", "/chart-of-accounts", noRole.token);
    assert(status === 200, `expected 200 (unchanged legacy behavior), got ${status}`);
  });

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
