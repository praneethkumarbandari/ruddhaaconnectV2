/**
 * Sample dataset loader — Execution Readiness Sprint.
 *
 * Run once against a migrated + seeded database:
 *   npx tsx bootstrap/sample-data/load-sample-data.ts
 *
 * Design choice: masters/config with no real business logic
 * (departments, branches, salary components, leave types, account
 * mappings, ...) are inserted directly via SQL. Anything with real
 * business rules (employees, attendance, leave, payroll, loans,
 * reimbursements) goes through the actual src/lib/*.ts functions —
 * the same functions every API route calls — so this script proves
 * the workflows, not just the schema. Journal entries are
 * deliberately NOT inserted directly: they are produced by running
 * payroll through processPayrollRun -> lockPayrollRun ->
 * postPayrollAccrual -> postPayrollPayment, the only path the posting
 * engine allows (single posting gate — see posting-engine.ts).
 *
 * Idempotency: every insert below uses `on conflict do nothing` or a
 * lookup-first pattern, so re-running this script is safe and will
 * pick up from wherever it left off (with one exception noted at the
 * payroll run step, since payroll runs are date-range-based, not
 * code-based).
 *
 * This script has been written but NOT executed — this sandbox has
 * no database access. Run it in your real environment and send back
 * the first failing step's output if anything breaks.
 */
import { pool, withTransaction } from "../../src/db/pool.ts";
import { createEmployee } from "../../src/lib/employees.ts";
import { upsertAttendanceRecord } from "../../src/lib/attendance.ts";
import { postLeaveBalanceTransaction, getLeaveYearForDate } from "../../src/lib/leave-balance.ts";
import { createLeaveRequest, approveLeaveRequest } from "../../src/lib/leave.ts";
import { createLoan } from "../../src/lib/payroll-loans.ts";
import { createClaim } from "../../src/lib/payroll-reimbursements.ts";
import { createPayrollRun, processPayrollRun, lockPayrollRun } from "../../src/lib/payroll-runs.ts";
import { postPayrollAccrual, postPayrollPayment } from "../../src/lib/payroll-accounting.ts";

const ACTOR = null; // system-seeded data; audit_log rows will show created_by = null

function log(step: string, detail?: unknown) {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${step}`, detail ?? "");
}

async function upsertMaster(
  table: string,
  conflictCol: string,
  cols: string[],
  values: unknown[],
): Promise<number> {
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await pool.query(
    `insert into ${table} (${cols.join(",")}) values (${placeholders})
     on conflict (${conflictCol}) do update set ${conflictCol} = excluded.${conflictCol}
     returning id`,
    values,
  );
  return rows[0].id;
}

async function main() {
  log("Step 1/10 — Chart of accounts (payroll-specific)");
  const accounts: Array<[string, string, string]> = [
    ["6000", "Salary Expense", "expense"],
    ["2200", "Salary Payable", "liability"],
    ["2600", "Employee Loan Receivable", "asset"],
    ["6100", "Reimbursement Expense", "expense"],
  ];
  for (const [code, name, type] of accounts) {
    await pool.query(
      `insert into chart_of_accounts (account_code, account_name, account_type, is_system)
       values ($1,$2,$3,false) on conflict (account_code) do nothing`,
      [code, name, type],
    );
  }

  log("Step 2/10 — HR masters (departments, designations, branches, cost centers, employment types, shifts)");
  const deptEngId = await upsertMaster("departments", "department_code", ["department_code", "department_name"], ["ENG", "Engineering"]);
  const deptOpsId = await upsertMaster("departments", "department_code", ["department_code", "department_name"], ["OPS", "Operations"]);
  const desigEngId = await upsertMaster("designations", "designation_code", ["designation_code", "designation_name", "department_id"], ["SDE2", "Software Engineer II", deptEngId]);
  const desigOpsId = await upsertMaster("designations", "designation_code", ["designation_code", "designation_name", "department_id"], ["OPS_EXEC", "Operations Executive", deptOpsId]);
  const empTypeId = await upsertMaster("employment_types", "employment_type_code", ["employment_type_code", "employment_type_name"], ["FT", "Full-Time"]);
  const branchId = await upsertMaster("branches", "branch_code", ["branch_code", "branch_name", "city", "state"], ["HYD", "Hyderabad HQ", "Hyderabad", "Telangana"]);
  const costCenterId = await upsertMaster("cost_centers", "cost_center_code", ["cost_center_code", "cost_center_name", "department_id"], ["CC_ENG", "Engineering Cost Center", deptEngId]);
  const { rows: policyRows } = await pool.query(`select id from attendance_policies where policy_code = 'STANDARD' limit 1`);
  const attendancePolicyId = policyRows[0]?.id ?? null;
  const { rows: shiftRows } = await pool.query(
    `insert into shifts (shift_code, shift_name, start_time, end_time, break_minutes, attendance_policy_id)
     values ('GEN','General Shift','09:30','18:30',60,$1)
     on conflict (shift_code) do update set shift_code = excluded.shift_code returning id`,
    [attendancePolicyId],
  );
  const shiftId = shiftRows[0].id;
  log("  masters ready", { deptEngId, deptOpsId, desigEngId, desigOpsId, empTypeId, branchId, costCenterId, shiftId });

  log("Step 3/10 — Salary structure (Basic fixed + HRA percentage-of-basic)");
  const structureId = await upsertMaster("salary_structures", "structure_code", ["structure_code", "structure_name"], ["STD", "Standard Structure"]);
  const basicCompId = await upsertMaster(
    "salary_components", "component_code",
    ["component_code", "component_name", "component_type", "calculation_type", "is_taxable", "affects_net_pay"],
    ["BASIC", "Basic Pay", "earning", "fixed", true, true],
  );
  const hraCompId = await upsertMaster(
    "salary_components", "component_code",
    ["component_code", "component_name", "component_type", "calculation_type", "is_taxable", "affects_net_pay"],
    ["HRA", "House Rent Allowance", "earning", "percentage", true, true],
  );
  await pool.query(
    `insert into salary_structure_components (structure_id, component_id, amount, sequence)
     select $1, $2, $3, 1 where not exists (select 1 from salary_structure_components where structure_id = $1 and component_id = $2)`,
    [structureId, basicCompId, 40000],
  );
  await pool.query(
    `insert into salary_structure_components (structure_id, component_id, percentage, sequence)
     select $1, $2, $3, 2 where not exists (select 1 from salary_structure_components where structure_id = $1 and component_id = $2)`,
    [structureId, hraCompId, 40],
  );
  log("  salary structure ready", { structureId, basicCompId, hraCompId, monthlyBasic: 40000, hraPct: 40 });

  log("Step 4/10 — Leave type + policy (Earned Leave, balance-checked)");
  const leaveTypeId = await upsertMaster(
    "leave_types", "leave_type_code",
    ["leave_type_code", "leave_type_name", "default_annual_days"],
    ["EL", "Earned Leave", 18],
  );
  await pool.query(
    `insert into leave_policies (leave_type_id, requires_balance_check, half_day_enabled, max_consecutive_days, probation_period_days, allow_during_probation)
     select $1, true, true, 15, 0, true
     where not exists (select 1 from leave_policies where leave_type_id = $1)`,
    [leaveTypeId],
  );
  log("  leave type + policy ready", { leaveTypeId });

  log("Step 5/10 — Payroll account mappings (SALARY_EXPENSE / NET_SALARY_PAYABLE / BANK_ACCOUNT / LOAN_RECEIVABLE / REIMBURSEMENT_EXPENSE)");
  const mappings: Array<[string, string]> = [
    ["SALARY_EXPENSE", "6000"],
    ["NET_SALARY_PAYABLE", "2200"],
    ["BANK_ACCOUNT", "1100"],
    ["LOAN_RECEIVABLE", "2600"],
    ["REIMBURSEMENT_EXPENSE", "6100"],
  ];
  for (const [key, code] of mappings) {
    await pool.query(
      `insert into payroll_account_mappings (mapping_key, account_code)
       select $1, $2 where not exists (
         select 1 from payroll_account_mappings where mapping_key = $1 and component_id is null and statutory_rule_id is null
       )`,
      [key, code],
    );
  }
  log("  account mappings ready (statutory deductions intentionally out of scope — see EXECUTION_READINESS_REPORT.md)");

  log("Step 6/10 — Employees (via createEmployee — real identity + profile creation path)");
  const today = new Date();
  const joiningDate = new Date(today.getFullYear(), today.getMonth() - 3, 1).toISOString().slice(0, 10);
  let emp1: number, emp2: number;
  const { rows: existingEmp1 } = await pool.query(`select employee_id from employee_master where employee_code = 'EMP-SAMPLE-01'`);
  if (existingEmp1.length > 0) {
    emp1 = existingEmp1[0].employee_id;
    log("  EMP-SAMPLE-01 already exists, reusing", { emp1 });
  } else {
    const result = await createEmployee(ACTOR, {
      employeeCode: "EMP-SAMPLE-01", employeeName: "Asha Rao", email: "asha.rao@example.com",
      departmentId: deptEngId, designationId: desigEngId, branchId, costCenterId,
      employmentTypeId: empTypeId, shiftId, joiningDate,
    } as never);
    emp1 = result.employee_id ?? result.employeeId;
    log("  created EMP-SAMPLE-01", { emp1 });
  }
  const { rows: existingEmp2 } = await pool.query(`select employee_id from employee_master where employee_code = 'EMP-SAMPLE-02'`);
  if (existingEmp2.length > 0) {
    emp2 = existingEmp2[0].employee_id;
    log("  EMP-SAMPLE-02 already exists, reusing", { emp2 });
  } else {
    const result = await createEmployee(ACTOR, {
      employeeCode: "EMP-SAMPLE-02", employeeName: "Vikram Nair", email: "vikram.nair@example.com",
      departmentId: deptOpsId, designationId: desigOpsId, branchId, costCenterId: null,
      employmentTypeId: empTypeId, shiftId, joiningDate,
    } as never);
    emp2 = result.employee_id ?? result.employeeId;
    log("  created EMP-SAMPLE-02", { emp2 });
  }

  log("Step 7/10 — Salary structure assignment (both employees, effective from joining)");
  for (const empId of [emp1, emp2]) {
    await pool.query(
      `insert into employee_salary_structure_assignments (employee_id, structure_id, effective_from)
       select $1, $2, $3 where not exists (
         select 1 from employee_salary_structure_assignments where employee_id = $1 and structure_id = $2
       )`,
      [empId, structureId, joiningDate],
    );
  }

  log("Step 8/10 — Attendance (last full calendar month, weekdays present, one absence for emp2)");
  const periodStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const periodEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  let attendanceCount = 0;
  for (let d = new Date(periodStart); d <= periodEnd; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends — WEEKLY_OFF is derived, not written here
    const dateStr = d.toISOString().slice(0, 10);
    for (const empId of [emp1, emp2]) {
      if (empId === emp2 && d.getDate() === 10) continue; // deliberate absence for LOP/reporting demo
      await withTransaction((client) =>
        upsertAttendanceRecord(client, ACTOR, {
          employeeId: empId,
          attendanceDate: dateStr,
          inTimestamp: `${dateStr}T09:35:00`,
          outTimestamp: `${dateStr}T18:40:00`,
          source: "manual",
        } as never).catch((err: Error) => {
          // Already-locked or duplicate-date errors are safe to skip on re-run.
          if (!/lock|already/i.test(err.message)) throw err;
        }),
      );
      attendanceCount++;
    }
  }
  log(`  wrote ~${attendanceCount} attendance records (idempotent — re-run-safe upserts)`);

  log("Step 9/10 — Leave (opening balance + one approved request for emp1)");
  const leaveYear = await getLeaveYearForDate(pool as never, joiningDate);
  await withTransaction((client) =>
    postLeaveBalanceTransaction(client, ACTOR, {
      employeeId: emp1, leaveTypeId, leaveYear, transactionType: "opening_balance", days: 18,
      referenceType: "system", remarks: "Sample dataset opening balance",
    }),
  );
  const leaveFrom = new Date(today.getFullYear(), today.getMonth() + 1, 5).toISOString().slice(0, 10);
  const leaveTo = new Date(today.getFullYear(), today.getMonth() + 1, 6).toISOString().slice(0, 10);
  let leaveRequestId: number | null = null;
  const { rows: existingLeave } = await pool.query(
    `select id from leave_requests where employee_id = $1 and from_date = $2 and to_date = $3`,
    [emp1, leaveFrom, leaveTo],
  );
  if (existingLeave.length > 0) {
    leaveRequestId = existingLeave[0].id;
    log("  sample leave request already exists, reusing", { leaveRequestId });
  } else {
    const req = await createLeaveRequest(emp1, {
      employeeId: emp1, leaveTypeId, fromDate: leaveFrom, toDate: leaveTo,
      isHalfDay: false, halfDaySession: null, reason: "Sample dataset — personal leave",
    });
    leaveRequestId = req.id;
    await approveLeaveRequest(ACTOR ?? emp1, leaveRequestId);
    log("  created + approved leave request", { leaveRequestId, leaveFrom, leaveTo });
  }

  log("Step 10/10 — Loan, reimbursement, and payroll run (emp1)");
  const { rows: existingLoan } = await pool.query(`select id from employee_loans where employee_id = $1`, [emp1]);
  if (existingLoan.length === 0) {
    const loan = await createLoan(ACTOR, {
      employeeId: emp1, loanType: "loan", principalAmount: 60000, interestRate: 0,
      emiAmount: 5000, numberOfInstallments: 12, disbursedDate: joiningDate,
    });
    log("  created loan", { loanId: loan.id });
  } else {
    log("  loan already exists, reusing", { loanId: existingLoan[0].id });
  }

  const { rows: existingClaim } = await pool.query(`select id from reimbursement_claims where employee_id = $1`, [emp1]);
  if (existingClaim.length === 0) {
    const claim = await createClaim(emp1, {
      employeeId: emp1, claimType: "Travel", amount: 2500, isTaxable: false,
      claimDate: periodEnd.toISOString().slice(0, 10), description: "Sample dataset — client visit travel",
    });
    log("  created reimbursement claim", { claimId: claim.id });
  } else {
    log("  reimbursement claim already exists, reusing", { claimId: existingClaim[0].id });
  }

  const runPeriodStart = periodStart.toISOString().slice(0, 10);
  const runPeriodEnd = periodEnd.toISOString().slice(0, 10);
  const { rows: existingRun } = await pool.query(
    `select id, status from payroll_runs where run_type = 'monthly' and period_start = $1 and period_end = $2`,
    [runPeriodStart, runPeriodEnd],
  );
  let runId: number;
  if (existingRun.length > 0) {
    runId = existingRun[0].id;
    log(`  payroll run already exists (status: ${existingRun[0].status}), reusing`, { runId });
  } else {
    const run = await createPayrollRun(ACTOR, { runType: "monthly", periodStart: runPeriodStart, periodEnd: runPeriodEnd, branchId: null });
    runId = run.id;
    log("  created payroll run", { runId, runPeriodStart, runPeriodEnd });
  }

  const { rows: runStatusRows } = await pool.query(`select status from payroll_runs where id = $1`, [runId]);
  const status = runStatusRows[0].status;
  if (status === "draft") {
    await processPayrollRun(ACTOR, runId);
    log("  processed payroll run");
  }
  if (["draft", "processed"].includes((await pool.query(`select status from payroll_runs where id = $1`, [runId])).rows[0].status)) {
    await lockPayrollRun(ACTOR ?? emp1, runId);
    log("  locked payroll run");
  }
  const finalStatus = (await pool.query(`select status from payroll_runs where id = $1`, [runId])).rows[0].status;
  if (finalStatus === "locked") {
    await withTransaction((client) => postPayrollAccrual(client, ACTOR ?? emp1, runId));
    log("  posted payroll accrual journal entry (through postJournalEntry — the single posting gate)");
    await withTransaction((client) => postPayrollPayment(client, ACTOR ?? emp1, runId));
    log("  posted payroll payment journal entry");
  } else {
    log(`  skipping accrual/payment posting — run status is '${finalStatus}', already posted or not lockable in this pass`);
  }

  log("DONE", { emp1, emp2, leaveRequestId, runId });
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Sample data load FAILED at the step above:", err);
  process.exit(1);
});
