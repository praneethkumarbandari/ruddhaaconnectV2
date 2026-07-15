import type { PgClient } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";
import { getEmployeeAssignmentSnapshot } from "./attendance.ts";
import { getActiveStatutoryRules, evaluateStatutoryRule } from "./payroll-statutory.ts";

/**
 * The calculation pipeline. Each numbered stage below is its own
 * exported function — independently testable, per the spec's
 * explicit requirement — composed by calculatePayrollLine() at the
 * bottom. Consumes Attendance and Leave by READING attendance_records
 * / leave_balance_transactions / leave_requests; writes nothing to
 * either. Every number that ends up in payroll_lines/
 * payroll_line_components is a SNAPSHOT taken at calculation time —
 * re-running this function later (before lock) recomputes from
 * current master data and REPLACES the snapshot; after lock, nothing
 * calls this function again for that run (enforced by the caller in
 * lib/payroll-runs.ts, not here).
 */

export class NoSalaryStructureAssignedError extends Error {
  constructor(employeeId: number, asOfDate: string) {
    super(`Employee ${employeeId} has no salary structure assigned as of ${asOfDate}.`);
    this.name = "NoSalaryStructureAssignedError";
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ------------------------------------------------------------
// STAGE 1: Employee Selection
// ------------------------------------------------------------
export async function selectEligibleEmployees(client: PgClient, periodStart: string, periodEnd: string, branchId?: number | null) {
  const conditions = [`em.joining_date <= $2`, `(em.exit_date is null or em.exit_date >= $1)`, `em.status <> 'exited'`];
  const params: unknown[] = [periodStart, periodEnd];
  if (branchId) { params.push(branchId); conditions.push(`em.branch_id = $${params.length}`); }

  const { rows } = await client.query(
    `select em.employee_id, em.joining_date, em.exit_date, em.department_id, em.branch_id, em.cost_center_id
     from employee_master em
     where ${conditions.join(" and ")}
     order by em.employee_id`,
    params,
  );
  return rows;
}

// ------------------------------------------------------------
// STAGE 2: Salary Structure Resolution
// ------------------------------------------------------------
export async function resolveSalaryStructure(client: PgClient, employeeId: number, asOfDate: string) {
  const { rows } = await client.query(
    `select essa.structure_id, ss.structure_code, ss.structure_name
     from employee_salary_structure_assignments essa
     join salary_structures ss on ss.id = essa.structure_id
     where essa.employee_id = $1 and essa.effective_from <= $2 and (essa.effective_to is null or essa.effective_to >= $2)
     order by essa.effective_from desc limit 1`,
    [employeeId, asOfDate],
  );
  if (rows.length === 0) throw new NoSalaryStructureAssignedError(employeeId, asOfDate);

  const { rows: components } = await client.query(
    `select ssc.*, sc.component_code, sc.component_name, sc.component_type, sc.calculation_type, sc.is_taxable, sc.affects_net_pay
     from salary_structure_components ssc
     join salary_components sc on sc.id = ssc.component_id
     where ssc.structure_id = $1
     order by ssc.sequence`,
    [rows[0].structure_id],
  );
  return { structureId: rows[0].structure_id, structureCode: rows[0].structure_code, components };
}

// ------------------------------------------------------------
// STAGE 3: Attendance Resolution — reads attendance_records only.
// ------------------------------------------------------------
export async function resolveAttendance(client: PgClient, employeeId: number, periodStart: string, periodEnd: string) {
  // Joins through leave_request_id to the actual leave type's pay
  // policy — NOT just ast.is_paid — because attendance_statuses'
  // single ON_LEAVE status has a fixed is_paid=true (Milestone 4's
  // seed) regardless of which leave TYPE actually produced it. A
  // Loss-of-Pay leave request still syncs to attendance_records as
  // plain ON_LEAVE (see lib/leave.ts's applyLeaveToAttendance — it has
  // no separate "on leave, unpaid" status), so trusting ast.is_paid
  // alone would incorrectly treat LOP leave as paid attendance. This
  // join is also what makes it safe for this function's own paidDays/
  // lopDays to be used directly for pro-ration, with no second
  // addition from resolveLeave() needed — see calculatePayrollLine()'s
  // comment for the double-counting bug this replaced.
  const { rows } = await client.query(
    `select ar.attendance_date, ast.status_code, ast.is_paid, ar.is_half_day, ar.late_minutes, ar.overtime_minutes,
            ar.source, lp.requires_balance_check as leave_requires_balance_check
     from attendance_records ar
     join attendance_statuses ast on ast.id = ar.status_id
     left join leave_requests lr on lr.id = ar.leave_request_id
     left join leave_policies lp on lp.leave_type_id = lr.leave_type_id
     where ar.employee_id = $1 and ar.attendance_date between $2 and $3`,
    [employeeId, periodStart, periodEnd],
  );

  const totalCalendarDays = Math.round((new Date(`${periodEnd}T00:00:00Z`).getTime() - new Date(`${periodStart}T00:00:00Z`).getTime()) / 86400000) + 1;
  let paidDays = 0, lopDays = 0, lateDays = 0, overtimeMinutes = 0, daysWithRecord = 0;

  for (const r of rows) {
    daysWithRecord++;
    if (r.late_minutes > 0) lateDays++;
    overtimeMinutes += Number(r.overtime_minutes ?? 0);

    // Override ast.is_paid specifically for a leave-sourced record
    // whose actual leave type is Loss-of-Pay (requires_balance_check
    // = false). For every other source (biometric_import, manual,
    // correction, or a leave-sourced record for an ordinary paid
    // leave type), ast.is_paid is trusted as-is.
    const isPaidDay = r.source === "leave" && r.leave_requires_balance_check === false ? false : r.is_paid;

    if (isPaidDay) {
      paidDays += r.is_half_day ? 0.5 : 1;
    } else {
      lopDays += r.is_half_day ? 0.5 : 1;
    }
  }
  // Days in the period with NO attendance_records row at all are
  // treated as unpaid (LOP) — a genuine gap in the data (nobody ran
  // an import or marked attendance) should never silently default to
  // "paid." This mirrors the same "don't fabricate a favorable
  // default" discipline as INCOMPLETE not defaulting to PRESENT.
  const daysWithNoRecord = totalCalendarDays - daysWithRecord;
  lopDays += daysWithNoRecord;

  return {
    workingDays: totalCalendarDays,
    paidDays,
    lopDays,
    lateDays,
    overtimeMinutes,
    overtimeHours: Math.round((overtimeMinutes / 60) * 100) / 100,
  };
}

// ------------------------------------------------------------
// STAGE 4: Leave Resolution — reads leave_requests/leave_balance_transactions,
// adding leave-TYPE granularity attendance alone can't provide
// (attendance only knows "ON_LEAVE", not which leave type, and can't
// see encashment at all). Never writes to either table.
// ------------------------------------------------------------
export async function resolveLeave(client: PgClient, employeeId: number, periodStart: string, periodEnd: string, leaveYear: number) {
  const { rows: leaveDays } = await client.query(
    `select lr.leave_type_id, lt.leave_type_name, lp.requires_balance_check, sum(lr.day_count) as days
     from leave_requests lr
     join leave_types lt on lt.id = lr.leave_type_id
     left join leave_policies lp on lp.leave_type_id = lr.leave_type_id
     where lr.employee_id = $1 and lr.status = 'approved' and lr.from_date <= $3 and lr.to_date >= $2
     group by lr.leave_type_id, lt.leave_type_name, lp.requires_balance_check`,
    [employeeId, periodStart, periodEnd],
  );

  const paidLeaveDays = leaveDays.filter((r) => r.requires_balance_check !== false).reduce((sum, r) => sum + Number(r.days), 0);
  const lopLeaveDays = leaveDays.filter((r) => r.requires_balance_check === false).reduce((sum, r) => sum + Number(r.days), 0);

  const { rows: encashmentRows } = await client.query(
    `select coalesce(sum(-days), 0) as encashed_days
     from leave_balance_transactions lbt
     where lbt.employee_id = $1 and lbt.leave_year = $2 and lbt.transaction_type = 'encashment'
       and lbt.created_at::date between $3 and $4`,
    [employeeId, leaveYear, periodStart, periodEnd],
  );

  return {
    byType: leaveDays.map((r) => ({ leaveTypeId: r.leave_type_id, leaveTypeName: r.leave_type_name, days: Number(r.days), isPaid: r.requires_balance_check !== false })),
    paidLeaveDays,
    lopLeaveDays,
    encashedDays: Number(encashmentRows[0]?.encashed_days ?? 0),
  };
}

// ------------------------------------------------------------
// STAGES 5-6: Earnings & Deductions.
// Pro-ration convention (disclosed, not hidden): every earning and
// structure-defined deduction is pro-rated by paidDays/workingDays —
// LOP proportionally reduces both earnings and structure deductions.
// Statutory deductions (Stage 11) are computed on the PRO-RATED basic/
// gross, so they're automatically consistent with LOP, not a separate
// adjustment.
//
// Percentage-type components are computed as a percentage of the
// structure's own lowest-sequence FIXED earning component — the
// conventional "HRA as % of Basic" pattern. This is a real, disclosed
// convention, not an arbitrary guess: salary_structure_components
// (Milestone 1) never specified what a percentage is relative to,
// and this is the most common real-world interpretation.
//
// 'formula' components are out of scope this milestone (see
// PAYROLL_CALCULATION.md's disclosed limitations) — none are
// evaluated here; if one exists in a structure it contributes zero,
// which is a real, visible gap in the payslip rather than a silent
// miscalculation, and is called out explicitly in the doc.
// ------------------------------------------------------------
export type ComponentBreakdown = { componentId: number; componentCode: string; componentType: string; amount: number };

export function calculateEarningsAndDeductions(
  components: Array<{ component_id: number; component_code: string; component_type: string; calculation_type: string; amount: string | null; percentage: string | null }>,
  proRationFactor: number,
): { earnings: ComponentBreakdown[]; deductions: ComponentBreakdown[]; basicPay: number } {
  const fixedEarnings = components.filter((c) => c.component_type === "earning" && c.calculation_type === "fixed");
  const basicComponent = fixedEarnings[0]; // lowest sequence, since the query orders by sequence
  const basicPayFull = basicComponent ? Number(basicComponent.amount ?? 0) : 0;

  const earnings: ComponentBreakdown[] = [];
  const deductions: ComponentBreakdown[] = [];

  for (const c of components) {
    let fullAmount = 0;
    if (c.calculation_type === "fixed") fullAmount = Number(c.amount ?? 0);
    else if (c.calculation_type === "percentage") fullAmount = round2(basicPayFull * (Number(c.percentage ?? 0) / 100));
    // else: 'formula' — contributes 0, see note above.

    const proRated = round2(fullAmount * proRationFactor);
    const entry = { componentId: c.component_id, componentCode: c.component_code, componentType: c.component_type, amount: proRated };
    if (c.component_type === "earning") earnings.push(entry);
    else deductions.push(entry);
  }

  const basicPay = round2(basicPayFull * proRationFactor);
  return { earnings, deductions, basicPay };
}

// ------------------------------------------------------------
// STAGE 11: Statutory Calculations
// ------------------------------------------------------------
export async function calculateStatutoryDeductions(client: PgClient, asOfDate: string, wages: { basic: number; gross: number }) {
  const rules = await getActiveStatutoryRules(client, asOfDate);
  const results = [];
  for (const rule of rules) {
    results.push(await evaluateStatutoryRule(client, rule, wages));
  }
  return results;
}

/**
 * Orchestrates all stages for one employee, one run, and writes the
 * result. Deletes any existing payroll_lines row for this
 * (run, employee) first — reprocessing is a delete + reinsert, not an
 * update, so a failed recompute can never leave a half-updated row
 * (payroll_line_components cascades on payroll_lines' delete).
 * The CALLER (lib/payroll-runs.ts) is responsible for verifying the
 * run isn't locked before calling this — this function does not
 * check the run's own status, matching the same separation as
 * upsertAttendanceRecord() not checking permissions itself.
 */
export async function calculatePayrollLine(
  client: PgClient,
  actorUserId: number | null,
  runId: number,
  employeeId: number,
  periodStart: string,
  periodEnd: string,
  manualAdjustments: Array<{ componentId: number; componentType: "earning" | "deduction"; amount: number }> = [],
) {
  const structure = await resolveSalaryStructure(client, employeeId, periodEnd);
  const attendance = await resolveAttendance(client, employeeId, periodStart, periodEnd);
  // Stage 4 (Leave Resolution) is intentionally NOT called here.
  // resolveAttendance() above already resolves each leave-sourced
  // day's true pay status (paid leave vs. Loss-of-Pay leave) via its
  // join to leave_requests/leave_policies, so the numeric pipeline
  // needs nothing further from Leave. resolveLeave() itself is still
  // a real, exported, independently-testable stage — its consumer is
  // the payslip's Leave Summary (lib/payroll-reports.ts's
  // generatePayslip()), which needs the by-leave-type breakdown and
  // encashment figures resolveAttendance correctly has no reason to
  // compute. See PAYROLL_CALCULATION.md for the full reasoning.

  // attendance.paidDays/lopDays are already complete and correct on
  // their own — resolveAttendance() resolves each leave-sourced day's
  // TRUE pay status (via the leave type's requires_balance_check),
  // not just attendance_statuses.is_paid. Adding leave.paidLeaveDays
  // here again would double-count the same days a second time (a
  // real bug this replaced — see resolveAttendance()'s comment for
  // the worked example of how it silently masked absence-driven LOP
  // whenever leave coexisted with absence in the same period).
  // resolveLeave()'s day-count breakdown is used for payslip/report
  // purposes (which specific leave type, for the leave summary), not
  // fed back into this arithmetic.
  const paidDaysTotal = attendance.paidDays;
  const proRationFactor = attendance.workingDays > 0 ? Math.min(1, paidDaysTotal / attendance.workingDays) : 0;

  const { earnings, deductions, basicPay } = calculateEarningsAndDeductions(structure.components, proRationFactor);

  // Stage 9: Overtime — hourly rate derived from basic pay over a
  // standard 208-hour month (26 days x 8h). A configurable
  // overtime-rate table is a disclosed future improvement (see
  // PAYROLL_CALCULATION.md), not built this milestone. Folded
  // straight into gross_earnings/payroll_lines.overtime_amount, not
  // given its own payroll_line_components row (it has no
  // component_id or statutory_rule_id to attach to, and the CHECK
  // constraint on that table correctly requires one).
  const hourlyRate = basicPay > 0 ? basicPay / 208 : 0;
  const overtimeAmount = round2(attendance.overtimeHours * hourlyRate * 1.5);

  // Stage 7: Loan Recovery — pending installments due in this run's period.
  const periodTag = periodEnd.slice(0, 7); // 'YYYY-MM'
  const { rows: dueInstallments } = await client.query(
    `select id, emi_amount from loan_installments where loan_id in (select id from employee_loans where employee_id = $1) and due_period = $2 and status = 'pending'`,
    [employeeId, periodTag],
  );
  const loanRecoveryAmount = round2(dueInstallments.reduce((sum, r) => sum + Number(r.emi_amount), 0));

  // Stage 8: Reimbursements — approved, not yet paid.
  const { rows: pendingReimbursements } = await client.query(
    `select id, amount from reimbursement_claims where employee_id = $1 and status = 'approved' and payroll_line_id is null`,
    [employeeId],
  );
  const reimbursementAmount = round2(pendingReimbursements.reduce((sum, r) => sum + Number(r.amount), 0));

  // Stage 10: Incentives / one-off adjustments — explicit manual input, not guessed.
  for (const adj of manualAdjustments) {
    const amount = round2(adj.amount);
    const entry: ComponentBreakdown = { componentId: adj.componentId, componentCode: "MANUAL", componentType: adj.componentType, amount };
    if (adj.componentType === "earning") earnings.push(entry); else deductions.push(entry);
  }

  const grossEarningsBeforeOvertime = round2(earnings.reduce((s, e) => s + e.amount, 0));
  const grossEarnings = round2(grossEarningsBeforeOvertime + overtimeAmount);
  const structureDeductions = round2(deductions.reduce((s, d) => s + d.amount, 0));

  // Stage 11: Statutory — computed on pro-rated basic/gross, so LOP
  // already flows through automatically.
  const statutoryResults = await calculateStatutoryDeductions(client, periodEnd, { basic: basicPay, gross: grossEarnings });
  const statutoryEmployeeTotal = round2(statutoryResults.reduce((s, r) => s + r.employeeShare, 0));

  // Stage 12-13: Gross / Net.
  const grossDeductions = round2(structureDeductions + statutoryEmployeeTotal);
  const netSalary = round2(grossEarnings - grossDeductions - loanRecoveryAmount + reimbursementAmount);

  const snapshot = await getEmployeeAssignmentSnapshot(client, employeeId);

  const { rows: existing } = await client.query(`select id from payroll_lines where payroll_run_id = $1 and employee_id = $2`, [runId, employeeId]);
  if (existing.length > 0) {
    await client.query(`delete from payroll_lines where id = $1`, [existing[0].id]); // cascades to payroll_line_components
  }

  const { rows: lineRows } = await client.query(
    `insert into payroll_lines (
       payroll_run_id, employee_id, salary_structure_id, working_days, paid_days, lop_days, overtime_hours, overtime_amount,
       gross_earnings, gross_deductions, loan_recovery_amount, reimbursement_amount, net_salary, department_id, branch_id, cost_center_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [
      runId, employeeId, structure.structureId, attendance.workingDays, paidDaysTotal, attendance.lopDays,
      attendance.overtimeHours, overtimeAmount, grossEarnings, grossDeductions, loanRecoveryAmount, reimbursementAmount, netSalary,
      snapshot.department_id, snapshot.branch_id, snapshot.cost_center_id,
    ],
  );
  const line = lineRows[0];

  for (const e of earnings) {
    await client.query(
      `insert into payroll_line_components (payroll_line_id, component_id, component_type, amount) values ($1,$2,'earning',$3)`,
      [line.id, e.componentId, e.amount],
    );
  }
  for (const d of deductions) {
    await client.query(
      `insert into payroll_line_components (payroll_line_id, component_id, component_type, amount) values ($1,$2,'deduction',$3)`,
      [line.id, d.componentId, d.amount],
    );
  }
  for (const s of statutoryResults) {
    if (s.employeeShare > 0) {
      await client.query(`insert into payroll_line_components (payroll_line_id, statutory_rule_id, component_type, amount) values ($1,$2,'deduction',$3)`, [line.id, s.ruleId, s.employeeShare]);
    }
    if (s.employerShare > 0) {
      await client.query(`insert into payroll_line_components (payroll_line_id, statutory_rule_id, component_type, amount) values ($1,$2,'employer_contribution',$3)`, [line.id, s.ruleId, s.employerShare]);
    }
  }

  await writeAudit(client, { userId: actorUserId, action: existing.length > 0 ? "update" : "create", module: "payroll_lines", recordId: line.id, newValue: line });

  return { line, earnings, deductions, statutoryResults, dueInstallmentIds: dueInstallments.map((r) => r.id), reimbursementClaimIds: pendingReimbursements.map((r) => r.id) };
}
