/**
 * HR MODULE — MILESTONE 4: LEAVE MANAGEMENT — REGRESSION SUITE
 * ==========================================================
 *
 * Run with:
 *   npx tsx test/leave-regression.ts
 *
 * Same technique as every prior HR regression suite: drives the real
 * Netlify Function `handler()` directly. Requires schema.sql through
 * schema-leave.sql all applied.
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
    requestContext: { requestId: "leave-test-" + Date.now(), identity: { sourceIp: "127.0.0.1" } },
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
const BOOTSTRAP_PASSWORD = "leave-test-password-123";

async function bootstrapEmployee(label: string, roleCode: string): Promise<{ id: number; token: string }> {
  const username = `leave_test_${label}_${RUN}`;
  const hash = await bcrypt.hash(BOOTSTRAP_PASSWORD, 4);
  const { rows } = await pool.query(
    `insert into employees (username, employee_name, password_hash) values ($1, $2, $3) returning id`,
    [username, `Leave Test ${label} ${RUN}`, hash],
  );
  const { rows: role } = await pool.query(`select id from roles where role_code = $1`, [roleCode]);
  assert(role.length === 1, `role ${roleCode} not found`);
  await pool.query(`insert into user_roles (employee_id, role_id) values ($1, $2)`, [rows[0].id, role[0].id]);
  const { status, body } = await call("POST", "/auth/login", null, { username, password: BOOTSTRAP_PASSWORD });
  assert(status === 200, `bootstrap login for ${label} failed: ${JSON.stringify(body)}`);
  return { id: rows[0].id, token: body.token };
}

/** Finds the next date matching a given ISO day-of-week (0=Sun..6=Sat) on or after `from`. */
function nextDow(from: Date, dow: number): Date {
  const d = new Date(from);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
function iso(d: Date): string { return d.toISOString().slice(0, 10); }

async function main() {
  const hrAdmin = await bootstrapEmployee("hradmin", "HR_ADMIN");
  const noRole = await bootstrapEmployee("norole", "EMPLOYEE");

  const { rows: deptRows } = await pool.query(`insert into departments (department_code, department_name) values ($1,'Leave Test Dept') returning id`, [`LVDEPT_${RUN}`]);
  const departmentId = deptRows[0].id;

  let managerEmployeeId = 0;
  let managerToken = "";
  await check("create manager employee via HR API", async () => {
    const { status, body } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `LV_MGR_${RUN}`, employeeName: "Leave Manager", departmentId, joiningDate: "2023-01-01",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    managerEmployeeId = body.employee_id;
    const login = await call("POST", "/auth/login", null, { username: body.username, password: body.temporaryPassword });
    managerToken = login.body.token;
  });

  let empEmployeeId = 0;
  let empToken = "";
  await check("create subordinate employee reporting to the manager", async () => {
    const { status, body } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `LV_EMP_${RUN}`, employeeName: "Leave Employee", departmentId,
      reportingManagerId: managerEmployeeId, joiningDate: "2023-01-01",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    empEmployeeId = body.employee_id;
    const login = await call("POST", "/auth/login", null, { username: body.username, password: body.temporaryPassword });
    empToken = login.body.token;
  });

  // Assign a weekly off (Sunday = 0) so day-count exclusion tests have something real to exclude.
  await pool.query(`insert into weekly_off_configurations (employee_id, day_of_week) values ($1, 0) on conflict do nothing`, [empEmployeeId]);
  await pool.query(`insert into weekly_off_configurations (employee_id, day_of_week) values ($1, 0) on conflict do nothing`, [managerEmployeeId]);

  let leaveTypeId = 0;
  await check("create a leave type (Milestone 1 master, not duplicated) and its Milestone 4 policy", async () => {
    const { status, body } = await call("POST", "/hr/leave-types", hrAdmin.token, {
      leaveTypeCode: `LVTYPE_${RUN}`, leaveTypeName: "Earned Leave", accrualFrequency: "yearly", defaultAnnualDays: 24,
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    leaveTypeId = body.id;

    const policy = await call("POST", "/leave/policies", hrAdmin.token, {
      leaveTypeId, requiresBalanceCheck: true, halfDayEnabled: true, sandwichRuleEnabled: false, countHolidaysAsLeave: false, maxConsecutiveDays: 10,
    });
    assert(policy.status === 201, `expected 201, got ${policy.status}: ${JSON.stringify(policy.body)}`);
  });

  let lopTypeId = 0;
  await check("create a Loss-of-Pay leave type with requiresBalanceCheck=false", async () => {
    const created = await call("POST", "/hr/leave-types", hrAdmin.token, { leaveTypeCode: `LOP_${RUN}`, leaveTypeName: "Loss of Pay" });
    lopTypeId = created.body.id;
    const policy = await call("POST", "/leave/policies", hrAdmin.token, { leaveTypeId: lopTypeId, requiresBalanceCheck: false, halfDayEnabled: false });
    assert(policy.status === 201, `expected 201, got ${policy.status}`);
  });

  await check("policy creation for an unknown leaveTypeId is rejected with 400", async () => {
    const { status } = await call("POST", "/leave/policies", hrAdmin.token, { leaveTypeId: 999999999 });
    assert(status === 400, `expected 400, got ${status}`);
  });

  // ------------------------------------------------------------
  // PERMISSION ENFORCEMENT
  // ------------------------------------------------------------
  await check("role-less employee cannot view leave requests HR-wide (403)", async () => {
    const { status } = await call("GET", "/leave/requests", noRole.token);
    assert(status === 403, `expected 403, got ${status}`);
  });

  // ------------------------------------------------------------
  // BALANCE LEDGER
  // ------------------------------------------------------------
  const leaveYear = new Date().getUTCFullYear();
  await check("post an opening balance and confirm it's reflected in the derived balance", async () => {
    const { status } = await call("POST", "/leave/balances/transactions", hrAdmin.token, {
      employeeId: empEmployeeId, leaveTypeId, leaveYear, transactionType: "opening_balance", days: 10,
    });
    assert(status === 201, `expected 201, got ${status}`);
    const bal = await call("GET", `/leave/balances?employeeId=${empEmployeeId}&leaveTypeId=${leaveTypeId}&leaveYear=${leaveYear}`, hrAdmin.token);
    assert(bal.status === 200 && Number(bal.body.balance) === 10, `expected balance 10, got ${JSON.stringify(bal.body)}`);
  });

  await check("a manual adjustment with positive days increases the derived balance", async () => {
    const { status } = await call("POST", "/leave/balances/transactions", hrAdmin.token, {
      employeeId: empEmployeeId, leaveTypeId, leaveYear, transactionType: "manual_adjustment", days: 5, remarks: "test bonus",
    });
    assert(status === 201, `manual_adjustment with positive days should succeed, got ${status}`);
    const bal = await call("GET", `/leave/balances?employeeId=${empEmployeeId}&leaveTypeId=${leaveTypeId}&leaveYear=${leaveYear}`, hrAdmin.token);
    assert(Number(bal.body.balance) === 15, `expected balance 15 after +5 adjustment, got ${JSON.stringify(bal.body)}`);
  });

  // ------------------------------------------------------------
  // DAY-COUNT CALCULATION: weekly-off exclusion
  // ------------------------------------------------------------
  const today = new Date();
  const nextMonday = nextDow(new Date(today.getTime() + 7 * 86400000), 1); // a Monday at least a week out, avoiding "past date" edge cases
  const spanningSunday = new Date(nextMonday); spanningSunday.setUTCDate(spanningSunday.getUTCDate() - 1); // the Sunday right before
  const fridayBefore = new Date(spanningSunday); fridayBefore.setUTCDate(fridayBefore.getUTCDate() - 2); // Friday before that Sunday

  let noSandwichRequestId = 0;
  await check("day count for a Fri-Mon request (no sandwich rule) excludes the weekly-off Sunday", async () => {
    const { status, body } = await call("POST", "/leave/requests", empToken, {
      leaveTypeId, fromDate: iso(fridayBefore), toDate: iso(nextMonday), reason: "day count test - no sandwich",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    // Fri, Sat, [Sun excluded], Mon = 3 counted days (Sat is a normal workday here, only Sunday is the configured weekly-off)
    assert(Number(body.day_count) === 3, `expected day_count 3 (Sunday excluded), got ${body.day_count}`);
    noSandwichRequestId = body.id;
    await call("POST", `/leave/requests/${noSandwichRequestId}/cancel`, empToken, { cancellationReason: "cleanup for next test" });
  });

  let leavePolicyId = 0;
  await check("enabling the sandwich rule on the policy", async () => {
    const { rows } = await pool.query(`select id from leave_policies where leave_type_id = $1`, [leaveTypeId]);
    leavePolicyId = rows[0].id;
    const patch = await call("PATCH", `/leave/policies/${leavePolicyId}`, hrAdmin.token, { sandwichRuleEnabled: true });
    assert(patch.status === 200 && patch.body.sandwich_rule_enabled === true, `expected sandwich rule enabled, got ${JSON.stringify(patch.body)}`);
  });

  let sandwichRequestId = 0;
  await check("with sandwich rule enabled, a Fri-Mon request counts all 4 days including the bridged Sunday", async () => {
    const { status, body } = await call("POST", "/leave/requests", empToken, {
      leaveTypeId, fromDate: iso(fridayBefore), toDate: iso(nextMonday), reason: "day count test - sandwich enabled",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert(Number(body.day_count) === 4, `expected day_count 4 (Sunday bridged), got ${body.day_count}`);
    sandwichRequestId = body.id;
  });

  await check("overlapping leave request is rejected", async () => {
    const { status } = await call("POST", "/leave/requests", empToken, {
      leaveTypeId, fromDate: iso(nextMonday), toDate: iso(nextMonday), reason: "overlap test",
    });
    assert(status === 422, `expected 422, got ${status}`);
  });

  await check("past-dated leave request is rejected", async () => {
    const { status } = await call("POST", "/leave/requests", empToken, {
      leaveTypeId, fromDate: "2020-01-01", toDate: "2020-01-02", reason: "past date test",
    });
    assert(status === 422, `expected 422, got ${status}`);
  });

  // ------------------------------------------------------------
  // INSUFFICIENT BALANCE
  // ------------------------------------------------------------
  await check("a request exceeding available balance is rejected", async () => {
    const farFuture = new Date(nextMonday); farFuture.setUTCDate(farFuture.getUTCDate() + 60);
    const farFutureEnd = new Date(farFuture); farFutureEnd.setUTCDate(farFutureEnd.getUTCDate() + 30); // 31 days, far more than the 15-day balance
    const { status, body } = await call("POST", "/leave/requests", empToken, {
      leaveTypeId, fromDate: iso(farFuture), toDate: iso(farFutureEnd), reason: "insufficient balance test",
    });
    assert(status === 422, `expected 422, got ${status}: ${JSON.stringify(body)}`);
  });

  await check("Loss of Pay leave type bypasses balance checking entirely", async () => {
    const farFuture = new Date(nextMonday); farFuture.setUTCDate(farFuture.getUTCDate() + 100);
    const { status, body } = await call("POST", "/leave/requests", empToken, {
      leaveTypeId: lopTypeId, fromDate: iso(farFuture), toDate: iso(farFuture), reason: "LOP test",
    });
    assert(status === 201, `expected 201 (no balance required for LOP), got ${status}: ${JSON.stringify(body)}`);
    await call("POST", `/leave/requests/${body.id}/cancel`, empToken, { cancellationReason: "cleanup" });
  });

  // ------------------------------------------------------------
  // HALF-DAY
  // ------------------------------------------------------------
  await check("half-day request across two different dates is rejected", async () => {
    const d1 = new Date(nextMonday); d1.setUTCDate(d1.getUTCDate() + 20);
    const d2 = new Date(d1); d2.setUTCDate(d2.getUTCDate() + 1);
    const { status } = await call("POST", "/leave/requests", empToken, {
      leaveTypeId, fromDate: iso(d1), toDate: iso(d2), isHalfDay: true, halfDaySession: "first_half", reason: "bad half day",
    });
    assert(status === 422, `expected 422, got ${status}`);
  });

  let halfDayRequestId = 0;
  await check("a valid half-day request has day_count 0.5", async () => {
    const d = new Date(nextMonday); d.setUTCDate(d.getUTCDate() + 21);
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1); // avoid landing on the weekly-off
    const { status, body } = await call("POST", "/leave/requests", empToken, {
      leaveTypeId, fromDate: iso(d), toDate: iso(d), isHalfDay: true, halfDaySession: "first_half", reason: "half day test",
    });
    assert(status === 201 && Number(body.day_count) === 0.5, `expected day_count 0.5, got ${status}: ${JSON.stringify(body)}`);
    halfDayRequestId = body.id;
  });

  // ------------------------------------------------------------
  // APPROVAL WORKFLOW + ATTENDANCE SYNC
  // ------------------------------------------------------------
  await check("a non-manager cannot approve", async () => {
    const { status } = await call("POST", `/leave/requests/${halfDayRequestId}/approve`, hrAdmin.token);
    assert(status === 403, `expected 403, got ${status}`);
  });

  await check("the real reporting manager approves level 1, advancing to HR level 2", async () => {
    const { status, body } = await call("POST", `/leave/requests/${halfDayRequestId}/approve`, managerToken);
    assert(status === 200 && body.status === "pending" && body.current_level_order === 2, `expected pending/level2, got ${status}: ${JSON.stringify(body)}`);
  });

  await check("HR_ADMIN approves the final level: balance is consumed and attendance is synced", async () => {
    const balBefore = await call("GET", `/leave/balances?employeeId=${empEmployeeId}&leaveTypeId=${leaveTypeId}&leaveYear=${leaveYear}`, hrAdmin.token);
    const { status, body } = await call("POST", `/leave/requests/${halfDayRequestId}/approve`, hrAdmin.token);
    assert(status === 200 && body.status === "approved", `expected approved, got ${status}: ${JSON.stringify(body)}`);

    const balAfter = await call("GET", `/leave/balances?employeeId=${empEmployeeId}&leaveTypeId=${leaveTypeId}&leaveYear=${leaveYear}`, hrAdmin.token);
    assert(Number(balAfter.body.balance) === Number(balBefore.body.balance) - 0.5, `expected balance to drop by 0.5, before=${balBefore.body.balance} after=${balAfter.body.balance}`);

    const { rows } = await pool.query(
      `select ast.status_code, ar.is_half_day, ar.source, ar.leave_request_id from attendance_records ar join attendance_statuses ast on ast.id = ar.status_id where ar.employee_id = $1 and ar.attendance_date = $2`,
      [empEmployeeId, body.from_date],
    );
    assert(rows.length === 1, "expected an attendance record synced for the approved leave day");
    assert(rows[0].status_code === "ON_LEAVE" && rows[0].source === "leave" && Number(rows[0].leave_request_id) === Number(halfDayRequestId), `unexpected synced attendance record: ${JSON.stringify(rows[0])}`);
    assert(rows[0].is_half_day === true, "expected is_half_day=true on the synced record");
  });

  await check("cancelling the now-approved leave reverses both attendance and balance", async () => {
    const balBefore = await call("GET", `/leave/balances?employeeId=${empEmployeeId}&leaveTypeId=${leaveTypeId}&leaveYear=${leaveYear}`, hrAdmin.token);

    const { status, body } = await call("POST", `/leave/requests/${halfDayRequestId}/cancel`, empToken, { cancellationReason: "plans changed" });
    assert(status === 200 && body.status === "cancelled", `expected cancelled, got ${status}: ${JSON.stringify(body)}`);

    const balAfter = await call("GET", `/leave/balances?employeeId=${empEmployeeId}&leaveTypeId=${leaveTypeId}&leaveYear=${leaveYear}`, hrAdmin.token);
    assert(Number(balAfter.body.balance) === Number(balBefore.body.balance) + 0.5, `expected balance restored by 0.5, before=${balBefore.body.balance} after=${balAfter.body.balance}`);

    const { rows } = await pool.query(`select 1 from attendance_records where leave_request_id = $1`, [halfDayRequestId]);
    assert(rows.length === 0, "expected the synced attendance record to be removed on cancellation");
  });

  // ------------------------------------------------------------
  // OWNERSHIP / AUTHORIZATION
  // ------------------------------------------------------------
  await check("an employee cannot cancel a DIFFERENT employee's leave request (403)", async () => {
    const { status } = await call("POST", `/leave/requests/${sandwichRequestId}/cancel`, managerToken, { cancellationReason: "unauthorized attempt" });
    assert(status === 403, `expected 403, got ${status}`);
  });

  await check("HR_ADMIN (leave.manage via HR_ADMIN role) CAN cancel on an employee's behalf", async () => {
    const { status, body } = await call("POST", `/leave/requests/${sandwichRequestId}/cancel`, hrAdmin.token, { cancellationReason: "HR override cleanup" });
    assert(status === 200 && body.status === "cancelled", `expected 200/cancelled, got ${status}: ${JSON.stringify(body)}`);
  });

  // ------------------------------------------------------------
  // REJECTION
  // ------------------------------------------------------------
  let rejectedRequestId = 0;
  await check("a leave request can be rejected by the manager", async () => {
    const d = new Date(nextMonday); d.setUTCDate(d.getUTCDate() + 40);
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    const created = await call("POST", "/leave/requests", empToken, { leaveTypeId, fromDate: iso(d), toDate: iso(d), reason: "reject test" });
    rejectedRequestId = created.body.id;
    const { status, body } = await call("POST", `/leave/requests/${rejectedRequestId}/reject`, managerToken, { decisionNotes: "Team coverage conflict." });
    assert(status === 200 && body.status === "rejected", `expected rejected, got ${status}: ${JSON.stringify(body)}`);
  });

  await check("a rejected request cannot subsequently be approved", async () => {
    const { status } = await call("POST", `/leave/requests/${rejectedRequestId}/approve`, managerToken);
    assert(status === 422, `expected 422, got ${status}`);
  });

  // ------------------------------------------------------------
  // ACCRUAL BATCH
  // ------------------------------------------------------------
  await check("running an accrual batch credits eligible employees", async () => {
    const { status, body } = await call("POST", "/leave/balances/accrue", hrAdmin.token, {
      leaveTypeId, leaveYear, periodStart: `${leaveYear}-01-01`, periodEnd: `${leaveYear}-12-31`, periodsPerYear: 1,
      employeeIds: [managerEmployeeId],
    });
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.processed === 1 && Number(body.results[0].days) === 24, `expected 24 days accrued for a full-year employee, got ${JSON.stringify(body)}`);
  });

  // ------------------------------------------------------------
  // PENDING APPROVALS REPORT
  // ------------------------------------------------------------
  await check("the manager's pending-approvals list includes a request awaiting their action", async () => {
    const d = new Date(nextMonday); d.setUTCDate(d.getUTCDate() + 45);
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    const created = await call("POST", "/leave/requests", empToken, { leaveTypeId, fromDate: iso(d), toDate: iso(d), reason: "pending approvals test" });
    assert(created.status === 201, "setup failed");

    const { status, body } = await call("GET", "/leave/requests/my/pending-approvals", managerToken);
    assert(status === 200, `expected 200, got ${status}`);
    assert(body.some((r: any) => r.id === created.body.id), "expected the new request in the manager's pending-approvals list");
  });

  // ------------------------------------------------------------
  // BACKWARD COMPATIBILITY
  // ------------------------------------------------------------
  await check("Milestone 1/2/3 endpoints remain unaffected", async () => {
    const a = await call("GET", "/hr/departments", hrAdmin.token);
    assert(a.status === 200, `departments: expected 200, got ${a.status}`);
    const b = await call("GET", "/attendance/policies", hrAdmin.token);
    assert(b.status === 200, `attendance policies: expected 200, got ${b.status}`);
  });

  await check("legacy accounting routes remain unaffected by leave.* permission gating", async () => {
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
