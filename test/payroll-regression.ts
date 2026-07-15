/**
 * HR MODULE — MILESTONE 5: PAYROLL ENGINE — REGRESSION SUITE
 * ==========================================================
 *
 * Run with:
 *   npx tsx test/payroll-regression.ts
 *
 * Same technique as every prior HR regression suite: drives the real
 * Netlify Function `handler()` directly. Requires schema.sql through
 * schema-payroll.sql all applied.
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
    requestContext: { requestId: "payroll-test-" + Date.now(), identity: { sourceIp: "127.0.0.1" } },
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
const BOOTSTRAP_PASSWORD = "payroll-test-password-123";

async function bootstrapEmployee(label: string, roleCode: string): Promise<{ id: number; token: string }> {
  const username = `payroll_test_${label}_${RUN}`;
  const hash = await bcrypt.hash(BOOTSTRAP_PASSWORD, 4);
  const { rows } = await pool.query(
    `insert into employees (username, employee_name, password_hash) values ($1, $2, $3) returning id`,
    [username, `Payroll Test ${label} ${RUN}`, hash],
  );
  const { rows: role } = await pool.query(`select id from roles where role_code = $1`, [roleCode]);
  assert(role.length === 1, `role ${roleCode} not found`);
  await pool.query(`insert into user_roles (employee_id, role_id) values ($1, $2)`, [rows[0].id, role[0].id]);
  const { status, body } = await call("POST", "/auth/login", null, { username, password: BOOTSTRAP_PASSWORD });
  assert(status === 200, `bootstrap login for ${label} failed: ${JSON.stringify(body)}`);
  return { id: rows[0].id, token: body.token };
}

async function seedAccount(code: string, name: string, type: string) {
  await pool.query(
    `insert into chart_of_accounts (account_code, account_name, account_type) values ($1,$2,$3) on conflict (account_code) do nothing`,
    [code, name, type],
  );
}

async function main() {
  const hrAdmin = await bootstrapEmployee("hradmin", "HR_ADMIN");
  const noRole = await bootstrapEmployee("norole", "EMPLOYEE");

  // FIX (test setup, not product code): this suite hardcodes dates in
  // Feb-Apr 2024 for reproducibility, but the seed script only ever
  // creates the financial year covering *today* (see src/db/seed.ts) —
  // there was never a financial year covering 2024 at all. Posting a
  // journal entry outside any known financial year is correctly and
  // safely refused by postJournalEntry() (NoFinancialYearError) — that
  // refusal is the product working as designed, not a bug. The gap was
  // this test never supplying the financial year its own hardcoded
  // dates need, exactly the same way it already supplies its own
  // chart-of-accounts codes below rather than assuming they exist.
  await pool.query(
    `insert into financial_years (code, start_date, end_date) values ('2023-24-payroll-test', '2024-01-01', '2024-12-31') on conflict (code) do nothing`,
  );

  // ------------------------------------------------------------
  // SETUP: chart of accounts, department, employee, salary structure,
  // structure assignment, statutory rule, account mappings.
  // ------------------------------------------------------------
  const salaryExpense = `SAL_EXP_${RUN}`, pfPayable = `PF_PAY_${RUN}`, pfExpense = `PF_EXP_${RUN}`,
    netSalaryPayable = `NET_PAY_${RUN}`, bankAccount = `BANK_${RUN}`, loanReceivable = `LOAN_REC_${RUN}`,
    reimbExpense = `REIMB_EXP_${RUN}`;

  await check("setup: seed chart of accounts", async () => {
    await seedAccount(salaryExpense, "Salary Expense", "expense");
    await seedAccount(pfPayable, "PF Payable", "liability");
    await seedAccount(pfExpense, "PF Employer Expense", "expense");
    await seedAccount(netSalaryPayable, "Net Salary Payable", "liability");
    await seedAccount(bankAccount, "Bank", "asset");
    await seedAccount(loanReceivable, "Loan Receivable", "asset");
    await seedAccount(reimbExpense, "Reimbursement Expense", "expense");
  });

  const { rows: deptRows } = await pool.query(`insert into departments (department_code, department_name) values ($1,'Payroll Test Dept') returning id`, [`PRDEPT_${RUN}`]);
  const departmentId = deptRows[0].id;
  const { rows: ccRows } = await pool.query(`insert into cost_centers (cost_center_code, cost_center_name, department_id) values ($1,'Payroll CC',$2) returning id`, [`PRCC_${RUN}`, departmentId]);
  const costCenterId = ccRows[0].id;

  let empId = 0, empToken = "";
  await check("create employee for payroll with a joining date well before the test period", async () => {
    const created = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `PR_EMP_${RUN}`, employeeName: "Payroll Employee", departmentId, joiningDate: "2023-01-01",
    });
    assert(created.status === 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    empId = created.body.employee_id;
    await pool.query(`update employee_master set cost_center_id = $1 where employee_id = $2`, [costCenterId, empId]);
    const login = await call("POST", "/auth/login", null, { username: created.body.username, password: created.body.temporaryPassword });
    empToken = login.body.token;
  });

  let managerEmployeeId = 0, managerToken = "";
  await check("give the employee a real reporting manager (must have an employee_master row per Milestone 2's validateReportingManager) — needed before any reporting-manager-gated approval (reimbursements, leave) can resolve", async () => {
    const mgrCreated = await call("POST", "/hr/employees", hrAdmin.token, { employeeCode: `PR_MGR_${RUN}`, employeeName: "Payroll Test Manager", departmentId, joiningDate: "2023-01-01" });
    assert(mgrCreated.status === 201, `setup: failed to create manager, got ${mgrCreated.status}: ${JSON.stringify(mgrCreated.body)}`);
    managerEmployeeId = mgrCreated.body.employee_id;
    const mgrLogin = await call("POST", "/auth/login", null, { username: mgrCreated.body.username, password: mgrCreated.body.temporaryPassword });
    managerToken = mgrLogin.body.token;

    const patch = await call("PATCH", `/hr/employees/${empId}`, hrAdmin.token, { reportingManagerId: managerEmployeeId });
    assert(patch.status === 200, `setup: failed to set reporting manager, got ${patch.status}: ${JSON.stringify(patch.body)}`);
  });

  let basicComponentId = 0, hraComponentId = 0, structureId = 0;
  await check("build a salary structure: fixed Basic Pay + percentage HRA", async () => {
    const basic = await call("POST", "/hr/salary-components", hrAdmin.token, { componentCode: `BASIC_${RUN}`, componentName: "Basic Pay", componentType: "earning", calculationType: "fixed" });
    basicComponentId = basic.body.id;
    const hra = await call("POST", "/hr/salary-components", hrAdmin.token, { componentCode: `HRA_${RUN}`, componentName: "HRA", componentType: "earning", calculationType: "percentage" });
    hraComponentId = hra.body.id;

    const structure = await call("POST", "/hr/salary-structures", hrAdmin.token, { structureCode: `STRUCT_${RUN}`, structureName: "Test Structure" });
    structureId = structure.body.id;

    const s1 = await call("POST", `/hr/salary-structures/${structureId}/components`, hrAdmin.token, { componentId: basicComponentId, amount: 30000, sequence: 1 });
    assert(s1.status === 201, `basic component: expected 201, got ${s1.status}`);
    const s2 = await call("POST", `/hr/salary-structures/${structureId}/components`, hrAdmin.token, { componentId: hraComponentId, percentage: 40, sequence: 2 });
    assert(s2.status === 201, `HRA component: expected 201, got ${s2.status}`);
  });

  await check("assign the salary structure to the employee (the versioning mechanism)", async () => {
    const { status, body } = await call("POST", "/payroll/salary-structure-assignments", hrAdmin.token, { employeeId: empId, structureId, effectiveFrom: "2023-01-01" });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });

  await check("overlapping salary structure assignment is rejected", async () => {
    const { status } = await call("POST", "/payroll/salary-structure-assignments", hrAdmin.token, { employeeId: empId, structureId, effectiveFrom: "2024-06-01" });
    assert(status === 409, `expected 409, got ${status}`);
  });

  let pfRuleId = 0;
  await check("create a configurable statutory rule (PF: 12% employee + 12% employer, on Basic)", async () => {
    const { status, body } = await call("POST", "/payroll/statutory-rules", hrAdmin.token, {
      ruleCode: `PF_${RUN}`, ruleName: "Provident Fund", calculationType: "percentage", wageBasis: "basic",
      rate: 12, employeeSharePercentage: 100, employerSharePercentage: 100, effectiveFrom: "2023-01-01",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    pfRuleId = body.id;
  });

  await check("configure account mappings for every posting role this run will use", async () => {
    const mappings = [
      { mappingKey: "SALARY_EXPENSE", accountCode: salaryExpense },
      { mappingKey: "EMPLOYEE_DEDUCTION_PAYABLE", statutoryRuleId: pfRuleId, accountCode: pfPayable },
      { mappingKey: "EMPLOYER_CONTRIBUTION_EXPENSE", statutoryRuleId: pfRuleId, accountCode: pfExpense },
      { mappingKey: "EMPLOYER_CONTRIBUTION_PAYABLE", statutoryRuleId: pfRuleId, accountCode: pfPayable },
      { mappingKey: "NET_SALARY_PAYABLE", accountCode: netSalaryPayable },
      { mappingKey: "BANK_ACCOUNT", accountCode: bankAccount },
      { mappingKey: "LOAN_RECEIVABLE", accountCode: loanReceivable },
      { mappingKey: "REIMBURSEMENT_EXPENSE", accountCode: reimbExpense },
    ];
    for (const m of mappings) {
      const { status, body } = await call("POST", "/payroll/account-mappings", hrAdmin.token, m);
      assert(status === 201, `mapping ${m.mappingKey}: expected 201, got ${status}: ${JSON.stringify(body)}`);
    }
  });

  // ------------------------------------------------------------
  // ATTENDANCE INTEGRATION: mark the employee present for a full test period
  // ------------------------------------------------------------
  const periodStart = "2024-02-01", periodEnd = "2024-02-29";
  await check("mark full attendance for every day of the payroll period (all present)", async () => {
    // resolveAttendance() (lib/payroll-calculation.ts) treats any day
    // with NO attendance_records row at all as unpaid (LOP) — there's
    // no weekly-off/holiday configured for this test employee, so
    // every single day of the 29-day period needs an explicit record
    // for the pro-ration factor to be 1.0, matching this test's
    // "full, unprorated gross earnings" assertion below. Marking only
    // a handful of sample dates (an earlier version of this test's
    // setup) would silently prorate earnings down to ~24% and every
    // amount assertion would be testing the wrong number.
    const start = new Date("2024-02-01T00:00:00Z");
    const end = new Date("2024-02-29T00:00:00Z");
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const { status } = await call("PUT", "/attendance/records/manual", hrAdmin.token, { employeeId: empId, attendanceDate: dateStr, inTimestamp: `${dateStr}T09:00:00Z`, outTimestamp: `${dateStr}T18:00:00Z` });
      assert(status === 200, `manual attendance for ${dateStr}: expected 200, got ${status}`);
    }
  });

  // ------------------------------------------------------------
  // LOAN
  // ------------------------------------------------------------
  let loanId = 0;
  await check("create a loan with an auto-generated installment schedule due in the test period", async () => {
    const { status, body } = await call("POST", "/payroll/loans", hrAdmin.token, {
      employeeId: empId, loanType: "loan", principalAmount: 12000, emiAmount: 1000, numberOfInstallments: 12, disbursedDate: "2024-01-01",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    loanId = body.id;
    const detail = await call("GET", `/payroll/loans/${loanId}`, hrAdmin.token);
    assert(detail.body.installments.length === 12, `expected 12 installments, got ${detail.body.installments.length}`);
    assert(detail.body.installments[0].due_period === "2024-02", `expected first installment due 2024-02, got ${detail.body.installments[0].due_period}`);
  });

  await check("EDGE CASE: a loan disbursed on the 31st correctly assigns due_periods without skipping February (setUTCMonth rollover bug, found and fixed during review)", async () => {
    const { status, body } = await call("POST", "/payroll/loans", hrAdmin.token, {
      employeeId: empId, loanType: "advance", principalAmount: 3000, emiAmount: 1000, numberOfInstallments: 3, disbursedDate: "2024-01-31",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    const detail = await call("GET", `/payroll/loans/${body.id}`, hrAdmin.token);
    const duePeriods = detail.body.installments.map((i: any) => i.due_period);
    // Jan 31 + 1/2/3 months should be Feb, Mar, Apr — NOT Mar, Apr, May
    // (which is what a naive `Date.setUTCMonth()` on a day-31 date
    // would produce, since February doesn't have 31 days and JS Date
    // silently rolls over to March 2nd/3rd instead of clamping to the
    // end of February).
    assert(JSON.stringify(duePeriods) === JSON.stringify(["2024-02", "2024-03", "2024-04"]), `expected [2024-02, 2024-03, 2024-04], got ${JSON.stringify(duePeriods)}`);
    // Settle it immediately so it doesn't interfere with this run's
    // loan-recovery assertions below (it shares due_period 2024-02
    // with the main test loan).
    await call("POST", `/payroll/loans/${body.id}/settle`, hrAdmin.token, { settlementNotes: "test cleanup, not part of this scenario" });
  });

  // ------------------------------------------------------------
  // REIMBURSEMENT
  // ------------------------------------------------------------
  let claimId = 0;
  await check("submit and approve a reimbursement claim (reporting manager level 1, then HR level 2 — same 2-level hierarchy as leave/attendance corrections)", async () => {
    const created = await call("POST", "/payroll/reimbursements", empToken, { claimType: "Travel", amount: 2500, isTaxable: false, claimDate: "2024-02-10" });
    assert(created.status === 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    claimId = created.body.id;

    const level1 = await call("POST", `/payroll/reimbursements/${claimId}/approve`, managerToken);
    assert(level1.status === 200 && level1.body.status === "pending", `expected pending at level 2, got ${level1.status}: ${JSON.stringify(level1.body)}`);

    const approved = await call("POST", `/payroll/reimbursements/${claimId}/approve`, hrAdmin.token);
    assert(approved.status === 200 && approved.body.status === "approved", `expected approved, got ${approved.status}: ${JSON.stringify(approved.body)}`);
  });

  // ------------------------------------------------------------
  // PAYROLL RUN — PROCESS
  // ------------------------------------------------------------
  let runId = 0;
  await check("create and process a monthly payroll run", async () => {
    const created = await call("POST", "/payroll/runs", hrAdmin.token, { runType: "monthly", periodStart, periodEnd });
    assert(created.status === 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    runId = created.body.id;

    const processed = await call("POST", `/payroll/runs/${runId}/process`, hrAdmin.token);
    assert(processed.status === 200 && processed.body.run.status === "processed", `expected processed, got ${processed.status}: ${JSON.stringify(processed.body)}`);
    assert(processed.body.results.some((r: any) => r.employeeId === empId && r.success), "expected the test employee's line to process successfully");
  });

  await check("salary calculation: Basic 30000 + HRA (40% of Basic = 12000) = gross 42000, PF employee 12% of Basic = 3600", async () => {
    const { status, body } = await call("GET", `/payroll/runs/${runId}`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}`);
    const line = body.lines.find((l: any) => l.employee_id === empId);
    assert(line, "expected a payroll line for the test employee");
    assert(Number(line.gross_earnings) === 42000, `expected gross_earnings 42000, got ${line.gross_earnings}`);
    // grossDeductions = PF employee share (3600); structure has no deduction components in this test.
    assert(Number(line.gross_deductions) === 3600, `expected gross_deductions 3600, got ${line.gross_deductions}`);
    assert(Number(line.loan_recovery_amount) === 1000, `expected loan_recovery_amount 1000, got ${line.loan_recovery_amount}`);
    assert(Number(line.reimbursement_amount) === 2500, `expected reimbursement_amount 2500, got ${line.reimbursement_amount}`);
    // net = 42000 - 3600 - 1000 + 2500 = 39900
    assert(Number(line.net_salary) === 39900, `expected net_salary 39900, got ${line.net_salary}`);
  });

  await check("payroll_line_components correctly records the employer PF contribution separately from the employee deduction", async () => {
    const { rows } = await pool.query(
      `select plc.component_type, plc.amount from payroll_line_components plc
       join payroll_lines pl on pl.id = plc.payroll_line_id
       where pl.payroll_run_id = $1 and pl.employee_id = $2 and plc.statutory_rule_id = $3`,
      [runId, empId, pfRuleId],
    );
    const employeeShare = rows.find((r) => r.component_type === "deduction");
    const employerShare = rows.find((r) => r.component_type === "employer_contribution");
    assert(Number(employeeShare?.amount) === 3600, `expected employee PF share 3600, got ${employeeShare?.amount}`);
    assert(Number(employerShare?.amount) === 3600, `expected employer PF share 3600, got ${employerShare?.amount}`);
  });

  await check("reprocessing before lock recomputes cleanly (idempotent)", async () => {
    const { status } = await call("POST", `/payroll/runs/${runId}/process`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}`);
    const runDetail = await call("GET", `/payroll/runs/${runId}`, hrAdmin.token);
    const linesForEmployee = runDetail.body.lines.filter((l: any) => l.employee_id === empId);
    assert(linesForEmployee.length === 1, `expected exactly 1 line after reprocessing (not a duplicate), got ${linesForEmployee.length}`);
  });

  // ------------------------------------------------------------
  // CRITICAL REGRESSION: mixed paid-leave + genuine-absence in the
  // SAME period. Found during review: an earlier version of
  // resolveAttendance()/calculatePayrollLine() double-counted approved
  // leave days (once via attendance_records' synced ON_LEAVE status,
  // again via a separate addition of resolveLeave()'s day count),
  // which could push the pro-ration factor above 1.0 and completely
  // MASK genuine absence-driven Loss of Pay whenever leave and
  // absence coexisted in the same period. This test exists
  // specifically because the original test suite (all-present, no
  // leave, no absence) could never have caught that bug — it only
  // exercises the trivial case that was never broken.
  // ------------------------------------------------------------
  /** First/last day of the month `monthsFromNow` months from today, plus day count. Sets the day to 1 BEFORE adding months — same lesson as the loan installment date-arithmetic bug fix above: never call setUTCMonth() on a Date whose day-of-month might not exist in the target month. */
  function monthRange(monthsFromNow: number): { start: string; end: string; daysInMonth: number; year: number; month: number } {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + monthsFromNow);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth(); // 0-indexed
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const pad = (n: number) => String(n).padStart(2, "0");
    return { start: `${year}-${pad(month + 1)}-01`, end: `${year}-${pad(month + 1)}-${pad(daysInMonth)}`, daysInMonth, year, month: month + 1 };
  }
  const dateInMonth = (r: { year: number; month: number }, day: number) => `${r.year}-${String(r.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  let mixedRunId = 0;
  const mixedMonth = monthRange(2); // safely in the future regardless of when this suite runs
  const aprilStart = mixedMonth.start, aprilEnd = mixedMonth.end;
  let paidLeaveTypeId = 0;
  await check("(setup) create a paid leave type, policy, and opening balance", async () => {
    const lt = await call("POST", "/hr/leave-types", hrAdmin.token, { leaveTypeCode: `PRPAIDLV_${RUN}`, leaveTypeName: "Payroll Test Paid Leave", defaultAnnualDays: 12 });
    paidLeaveTypeId = lt.body.id;
    const policy = await call("POST", "/leave/policies", hrAdmin.token, { leaveTypeId: paidLeaveTypeId, requiresBalanceCheck: true, halfDayEnabled: false });
    assert(policy.status === 201, `setup: leave policy failed, got ${policy.status}`);
    const opening = await call("POST", "/leave/balances/transactions", hrAdmin.token, { employeeId: empId, leaveTypeId: paidLeaveTypeId, leaveYear: mixedMonth.year, transactionType: "opening_balance", days: 10 });
    assert(opening.status === 201, `setup: opening balance failed, got ${opening.status}`);
  });

  await check("(setup) apply for and fully approve 5 days of paid leave", async () => {
    const leaveFrom = dateInMonth(mixedMonth, 8), leaveTo = dateInMonth(mixedMonth, 12);
    const applied = await call("POST", "/leave/requests", empToken, { leaveTypeId: paidLeaveTypeId, fromDate: leaveFrom, toDate: leaveTo, reason: "payroll pro-ration test" });
    assert(applied.status === 201 && Number(applied.body.day_count) === 5, `expected a 5-day leave request, got ${applied.status}: ${JSON.stringify(applied.body)}`);
    const lvl1 = await call("POST", `/leave/requests/${applied.body.id}/approve`, managerToken);
    assert(lvl1.status === 200 && lvl1.body.current_level_order === 2, `expected advance to level 2, got ${lvl1.status}: ${JSON.stringify(lvl1.body)}`);
    const lvl2 = await call("POST", `/leave/requests/${applied.body.id}/approve`, hrAdmin.token);
    assert(lvl2.status === 200 && lvl2.body.status === "approved", `expected approved, got ${lvl2.status}: ${JSON.stringify(lvl2.body)}`);
  });

  await check("(setup) mark every other day of the month present; leave days 13-17 with NO record at all (genuine absence)", async () => {
    // Deliberately does NOT assume a 30-day month — monthRange()
    // could land on a 28/29/30/31-day month depending on when this
    // suite runs, and hardcoding a day list sized for exactly 30
    // would silently corrupt this test's own arithmetic on a
    // different month length. Every day is accounted for explicitly:
    // days 8-12 are the approved leave (already synced), days 13-17
    // are left unrecorded (genuine absence), everything else in the
    // month is marked present.
    let presentCount = 0;
    for (let day = 1; day <= mixedMonth.daysInMonth; day++) {
      if (day >= 8 && day <= 17) continue; // 8-12 leave, 13-17 deliberately absent
      const d = dateInMonth(mixedMonth, day);
      const { status } = await call("PUT", "/attendance/records/manual", hrAdmin.token, { employeeId: empId, attendanceDate: d, inTimestamp: `${d}T09:00:00Z`, outTimestamp: `${d}T18:00:00Z` });
      assert(status === 200, `manual attendance for ${d}: expected 200, got ${status}`);
      presentCount++;
    }
    assert(presentCount === mixedMonth.daysInMonth - 10, `test setup arithmetic check failed: expected ${mixedMonth.daysInMonth - 10} present days, marked ${presentCount}`);
  });

  await check("payroll correctly computes paid days as (present + paid leave), NOT double-counted — the bug this replaced would have shown all days as paid", async () => {
    const created = await call("POST", "/payroll/runs", hrAdmin.token, { runType: "off_cycle", periodStart: aprilStart, periodEnd: aprilEnd });
    mixedRunId = created.body.id;
    const processed = await call("POST", `/payroll/runs/${mixedRunId}/process`, hrAdmin.token);
    assert(processed.status === 200, `expected 200, got ${processed.status}: ${JSON.stringify(processed.body)}`);

    const runDetail = await call("GET", `/payroll/runs/${mixedRunId}`, hrAdmin.token);
    const line = runDetail.body.lines.find((l: any) => l.employee_id === empId);
    assert(line, "expected a payroll line for the test employee");
    const expectedPaidDays = mixedMonth.daysInMonth - 5; // everything except the 5 genuinely-absent days
    const expectedLopDays = 5;
    assert(Number(line.paid_days) === expectedPaidDays, `expected paid_days ${expectedPaidDays} (present + paid leave, not double-counted), got ${line.paid_days}`);
    assert(Number(line.lop_days) === expectedLopDays, `expected lop_days ${expectedLopDays} (the genuinely unrecorded days), got ${line.lop_days}`);
    const expectedGross = Math.round(42000 * (expectedPaidDays / mixedMonth.daysInMonth) * 100) / 100;
    assert(Number(line.gross_earnings) === expectedGross, `expected gross_earnings ${expectedGross} (pro-rated), got ${line.gross_earnings}`);
  });

  // ------------------------------------------------------------
  // Loss-of-Pay leave type: verify it correctly reduces pay rather
  // than being treated as paid attendance (the second bug found in
  // the same review — ON_LEAVE has a single fixed is_paid=true
  // regardless of the underlying leave type's real pay policy).
  // ------------------------------------------------------------
  let lopLeaveTypeId = 0;
  const lopMonth = monthRange(3);
  await check("(setup) create a Loss-of-Pay leave type and apply/approve 3 days of it", async () => {
    const lt = await call("POST", "/hr/leave-types", hrAdmin.token, { leaveTypeCode: `PRLOPLV_${RUN}`, leaveTypeName: "Payroll Test LOP Leave" });
    lopLeaveTypeId = lt.body.id;
    const policy = await call("POST", "/leave/policies", hrAdmin.token, { leaveTypeId: lopLeaveTypeId, requiresBalanceCheck: false, halfDayEnabled: false });
    assert(policy.status === 201, `setup: LOP leave policy failed, got ${policy.status}`);

    const applied = await call("POST", "/leave/requests", empToken, { leaveTypeId: lopLeaveTypeId, fromDate: dateInMonth(lopMonth, 6), toDate: dateInMonth(lopMonth, 8), reason: "LOP leave test" });
    assert(applied.status === 201, `setup: expected 201, got ${applied.status}: ${JSON.stringify(applied.body)}`);
    await call("POST", `/leave/requests/${applied.body.id}/approve`, managerToken);
    const final = await call("POST", `/leave/requests/${applied.body.id}/approve`, hrAdmin.token);
    assert(final.body.status === "approved", `setup: expected approved, got ${JSON.stringify(final.body)}`);
  });

  await check("payroll correctly treats Loss-of-Pay leave days as unpaid, not as paid attendance", async () => {
    // Mark the rest of the month present so only the 3 LOP-leave days affect pro-ration.
    for (let day = 1; day <= lopMonth.daysInMonth; day++) {
      if (day >= 6 && day <= 8) continue; // the LOP leave days — deliberately no manual punch, ON_LEAVE already synced by approval
      const dateStr = dateInMonth(lopMonth, day);
      const { status } = await call("PUT", "/attendance/records/manual", hrAdmin.token, { employeeId: empId, attendanceDate: dateStr, inTimestamp: `${dateStr}T09:00:00Z`, outTimestamp: `${dateStr}T18:00:00Z` });
      assert(status === 200, `manual attendance for ${dateStr}: expected 200, got ${status}`);
    }

    const created = await call("POST", "/payroll/runs", hrAdmin.token, { runType: "off_cycle", periodStart: lopMonth.start, periodEnd: lopMonth.end });
    const processed = await call("POST", `/payroll/runs/${created.body.id}/process`, hrAdmin.token);
    assert(processed.status === 200, `expected 200, got ${processed.status}`);

    const runDetail = await call("GET", `/payroll/runs/${created.body.id}`, hrAdmin.token);
    const line = runDetail.body.lines.find((l: any) => l.employee_id === empId);
    assert(line, "expected a payroll line for the test employee");
    const expectedPaidDays = lopMonth.daysInMonth - 3;
    assert(Number(line.paid_days) === expectedPaidDays, `expected paid_days ${expectedPaidDays} (all days minus the 3 LOP leave days), got ${line.paid_days}`);
    assert(Number(line.lop_days) === 3, `expected lop_days 3 (the LOP leave days, correctly NOT treated as paid), got ${line.lop_days}`);
  });

  // ------------------------------------------------------------
  // JOURNAL POSTING PREVIEW (before lock/post — should still work as a preview)
  // ------------------------------------------------------------
  await check("journal posting preview is balanced", async () => {
    const { status, body } = await call("GET", `/payroll/posting/${runId}/preview`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.balanced === true, `expected a balanced preview, got debit=${body.totalDebit} credit=${body.totalCredit}`);
  });

  // ------------------------------------------------------------
  // LOCK
  // ------------------------------------------------------------
  await check("locking a processed run commits loan recovery and reimbursement payment", async () => {
    const { status, body } = await call("POST", `/payroll/runs/${runId}/lock`, hrAdmin.token);
    assert(status === 200 && body.status === "locked", `expected locked, got ${status}: ${JSON.stringify(body)}`);

    const { rows: installmentRows } = await pool.query(`select status from loan_installments where loan_id = $1 and due_period = '2024-02'`, [loanId]);
    assert(installmentRows[0].status === "recovered", `expected the Feb installment to be 'recovered', got ${installmentRows[0].status}`);

    const claim = await call("GET", `/payroll/reimbursements/${claimId}`, hrAdmin.token);
    assert(claim.body.status === "paid", `expected claim status 'paid', got ${claim.body.status}`);
  });

  await check("loan recovery committed at lock time is individually audited, not just the overarching run", async () => {
    const { rows } = await pool.query(`select 1 from audit_log where module = 'loan_installments' and record_id in (select id from loan_installments where loan_id = $1)`, [loanId]);
    assert(rows.length > 0, "expected at least one audit_log entry for module='loan_installments' after locking");
  });

  await check("reprocessing a locked run is rejected", async () => {
    const { status } = await call("POST", `/payroll/runs/${runId}/process`, hrAdmin.token);
    assert(status === 422, `expected 422, got ${status}`);
  });

  // ------------------------------------------------------------
  // ACCOUNTING POSTING
  // ------------------------------------------------------------
  let accrualJeId = 0;
  await check("posting the accrual creates a real, balanced journal entry through postJournalEntry", async () => {
    const { status, body } = await call("POST", `/payroll/posting/${runId}/post`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    accrualJeId = body.journalEntryId;

    const { rows: lines } = await pool.query(`select sum(debit) as total_debit, sum(credit) as total_credit from journal_entry_lines where journal_entry_id = $1`, [accrualJeId]);
    assert(Number(lines[0].total_debit) === Number(lines[0].total_credit), `journal entry does not balance: debit=${lines[0].total_debit} credit=${lines[0].total_credit}`);
    assert(Number(lines[0].total_debit) > 0, "expected a non-zero journal entry");
  });

  await check("posting the same run's accrual again is rejected", async () => {
    const { status } = await call("POST", `/payroll/posting/${runId}/post`, hrAdmin.token);
    assert(status !== 200, `expected a non-200 rejection, got ${status}`);
  });

  await check("posting the payment settlement creates a second balanced journal entry", async () => {
    const { status, body } = await call("POST", `/payroll/posting/${runId}/pay`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    const { rows: lines } = await pool.query(`select sum(debit) as total_debit, sum(credit) as total_credit from journal_entry_lines where journal_entry_id = $1`, [body.journalEntryId]);
    assert(Number(lines[0].total_debit) === Number(lines[0].total_credit), "payment journal entry does not balance");
  });

  await check("a posted run cannot be unlocked", async () => {
    const { status } = await call("POST", `/payroll/runs/${runId}/unlock`, hrAdmin.token, { reopenReason: "test attempt" });
    assert(status === 422, `expected 422, got ${status}`);
  });

  // ------------------------------------------------------------
  // UNLOCK on a SEPARATE, not-yet-posted run — verify reversal
  // ------------------------------------------------------------
  let secondRunId = 0;
  await check("(setup) a second run, processed and locked but not posted", async () => {
    const created = await call("POST", "/payroll/runs", hrAdmin.token, { runType: "off_cycle", periodStart: "2024-03-01", periodEnd: "2024-03-31" });
    secondRunId = created.body.id;
    await call("POST", `/payroll/runs/${secondRunId}/process`, hrAdmin.token);
    const locked = await call("POST", `/payroll/runs/${secondRunId}/lock`, hrAdmin.token);
    assert(locked.status === 200, `setup: expected locked, got ${locked.status}`);
  });

  await check("unlocking a locked-but-not-posted run reverses its loan/reimbursement commitments", async () => {
    const { status, body } = await call("POST", `/payroll/runs/${secondRunId}/unlock`, hrAdmin.token, { reopenReason: "correction needed" });
    assert(status === 200 && body.status === "reopened", `expected reopened, got ${status}: ${JSON.stringify(body)}`);
  });

  // ------------------------------------------------------------
  // PERMISSION ENFORCEMENT
  // ------------------------------------------------------------
  await check("role-less employee cannot view payroll runs (403)", async () => {
    const { status } = await call("GET", "/payroll/runs", noRole.token);
    assert(status === 403, `expected 403, got ${status}`);
  });

  await check("an employee without payroll.lock cannot lock a run (403)", async () => {
    const { status } = await call("POST", `/payroll/runs/${secondRunId}/lock`, noRole.token);
    assert(status === 403, `expected 403, got ${status}`);
  });

  await check("employee can view their own payslip but not another employee's", async () => {
    const { rows } = await pool.query(`select id from payroll_lines where payroll_run_id = $1 and employee_id = $2`, [runId, empId]);
    const lineId = rows[0].id;
    const own = await call("GET", `/payroll/reports/my/payslip/${lineId}`, empToken);
    assert(own.status === 200, `expected 200, got ${own.status}`);
    const other = await call("GET", `/payroll/reports/my/payslip/${lineId}`, noRole.token);
    assert(other.status === 403, `expected 403 for a different employee's payslip, got ${other.status}`);
  });

  // ------------------------------------------------------------
  // AUDIT LOGGING
  // ------------------------------------------------------------
  await check("payroll run lock/post actions are audited, including a distinct 'post' entry for the accrual posting step", async () => {
    const { rows } = await pool.query(`select action from audit_log where module = 'payroll_runs' and record_id = $1 order by performed_at`, [runId]);
    assert(rows.some((r) => r.action === "create"), "expected a 'create' audit entry for the run");
    assert(rows.some((r) => r.action === "post"), "expected a 'post' audit entry for the accrual posting step (found and fixed during review — this was previously missing)");
    assert(rows.length >= 4, `expected multiple audit entries (create, process, lock, post, payment), got ${rows.length}`);
  });

  // ------------------------------------------------------------
  // BACKWARD COMPATIBILITY
  // ------------------------------------------------------------
  await check("Milestones 1-4 endpoints remain unaffected", async () => {
    const a = await call("GET", "/hr/departments", hrAdmin.token);
    assert(a.status === 200, `departments: expected 200, got ${a.status}`);
    const b = await call("GET", "/leave/policies", hrAdmin.token);
    assert(b.status === 200, `leave policies: expected 200, got ${b.status}`);
  });

  await check("legacy accounting routes remain unaffected by payroll.* permission gating", async () => {
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
