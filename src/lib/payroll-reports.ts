import { pool, withTransaction, query } from "../db/pool.ts";
import { resolveAccountCode } from "./payroll-accounts.ts";
import { resolveLeave } from "./payroll-calculation.ts";
import { getLeaveYearForDate } from "./leave-balance.ts";
import { toIsoDate } from "./attendance.ts";

export async function payrollRegister(runId: number) {
  const { rows } = await query(
    `select pl.*, e.employee_name, em.employee_code, d.department_name
     from payroll_lines pl
     join employees e on e.id = pl.employee_id
     join employee_master em on em.employee_id = pl.employee_id
     left join departments d on d.id = pl.department_id
     where pl.payroll_run_id = $1
     order by em.employee_code`,
    [runId],
  );
  return rows;
}

export async function salaryRegister(runId: number) {
  const { rows } = await query(
    `select pl.employee_id, em.employee_code, e.employee_name, plc.component_type,
            coalesce(sc.component_code, sr.rule_code) as line_code, plc.amount
     from payroll_line_components plc
     join payroll_lines pl on pl.id = plc.payroll_line_id
     join employees e on e.id = pl.employee_id
     join employee_master em on em.employee_id = pl.employee_id
     left join salary_components sc on sc.id = plc.component_id
     left join statutory_rules sr on sr.id = plc.statutory_rule_id
     where pl.payroll_run_id = $1
     order by em.employee_code, plc.component_type`,
    [runId],
  );
  return rows;
}

/** Derived from transactional records only — no stored payslip table. */
export async function generatePayslip(payrollLineId: number) {
  const { rows: lineRows } = await query(
    `select pl.*, e.employee_name, em.employee_code, e.email, d.department_name, br.branch_name, pr.period_start, pr.period_end, pr.run_type
     from payroll_lines pl
     join employees e on e.id = pl.employee_id
     join employee_master em on em.employee_id = pl.employee_id
     join payroll_runs pr on pr.id = pl.payroll_run_id
     left join departments d on d.id = pl.department_id
     left join branches br on br.id = pl.branch_id
     where pl.id = $1`,
    [payrollLineId],
  );
  if (lineRows.length === 0) return null;
  const line = lineRows[0];

  const { rows: components } = await query(
    `select plc.component_type, coalesce(sc.component_name, sr.rule_name) as line_name, plc.amount
     from payroll_line_components plc
     left join salary_components sc on sc.id = plc.component_id
     left join statutory_rules sr on sr.id = plc.statutory_rule_id
     where plc.payroll_line_id = $1
     order by plc.component_type`,
    [payrollLineId],
  );

  const { rows: loanLines } = await query(`select loan_id, emi_amount, principal_component, interest_component from loan_installments where payroll_line_id = $1`, [payrollLineId]);
  const { rows: reimbursementLines } = await query(`select claim_type, amount, is_taxable from reimbursement_claims where payroll_line_id = $1`, [payrollLineId]);

  // Leave Summary — explicitly required on payslips per the spec.
  // Computed via the real, independently-testable Stage 4
  // (resolveLeave) from lib/payroll-calculation.ts — not duplicated
  // query logic — using a fresh withTransaction() since this report
  // function otherwise only uses the plain `pool`. This is the
  // genuine consumer of Stage 4's by-leave-type/encashment breakdown;
  // see PAYROLL_CALCULATION.md for why the numeric pipeline itself no
  // longer needs it (resolveAttendance resolves paid-vs-LOP leave
  // status directly).
  const periodStartIso = toIsoDate(line.period_start);
  const periodEndIso = toIsoDate(line.period_end);
  const leaveYear = await withTransaction((client) => getLeaveYearForDate(client, periodStartIso));
  const leaveSummary = await withTransaction((client) => resolveLeave(client, line.employee_id, periodStartIso, periodEndIso, leaveYear));

  return {
    employee: { code: line.employee_code, name: line.employee_name, department: line.department_name, branch: line.branch_name },
    period: { start: line.period_start, end: line.period_end, runType: line.run_type },
    attendanceSummary: { workingDays: Number(line.working_days), paidDays: Number(line.paid_days), lopDays: Number(line.lop_days), overtimeHours: Number(line.overtime_hours) },
    leaveSummary,
    earnings: components.filter((c) => c.component_type === "earning"),
    deductions: components.filter((c) => c.component_type === "deduction"),
    employerContributions: components.filter((c) => c.component_type === "employer_contribution"),
    loanRecovery: loanLines,
    reimbursements: reimbursementLines,
    grossEarnings: Number(line.gross_earnings),
    grossDeductions: Number(line.gross_deductions),
    netSalary: Number(line.net_salary),
  };
}

export async function loanRecoveryReport(periodTag: string) {
  const { rows } = await query(
    `select li.*, el.employee_id, em.employee_code, e.employee_name, el.loan_type
     from loan_installments li
     join employee_loans el on el.id = li.loan_id
     join employees e on e.id = el.employee_id
     join employee_master em on em.employee_id = el.employee_id
     where li.due_period = $1
     order by em.employee_code`,
    [periodTag],
  );
  return rows;
}

export async function departmentPayrollSummary(runId: number) {
  const { rows } = await query(
    `select d.department_name, count(*) as employee_count, sum(pl.gross_earnings) as total_gross, sum(pl.net_salary) as total_net
     from payroll_lines pl left join departments d on d.id = pl.department_id
     where pl.payroll_run_id = $1
     group by d.department_name order by d.department_name`,
    [runId],
  );
  return rows;
}

export async function costCenterPayrollSummary(runId: number) {
  const { rows } = await query(
    `select cc.cost_center_name, count(*) as employee_count, sum(pl.gross_earnings) as total_gross, sum(pl.net_salary) as total_net
     from payroll_lines pl left join cost_centers cc on cc.id = pl.cost_center_id
     where pl.payroll_run_id = $1
     group by cc.cost_center_name order by cc.cost_center_name`,
    [runId],
  );
  return rows;
}

/** Bank Transfer Report: employee, account details, net amount — derived, never stored as its own table. */
export async function bankTransferReport(runId: number) {
  const { rows } = await query(
    `select em.employee_code, e.employee_name, pl.net_salary, ebd.bank_name, ebd.account_number, ebd.ifsc_code, ebd.account_holder_name
     from payroll_lines pl
     join employees e on e.id = pl.employee_id
     join employee_master em on em.employee_id = pl.employee_id
     left join employee_bank_details ebd on ebd.employee_id = pl.employee_id
     where pl.payroll_run_id = $1
     order by em.employee_code`,
    [runId],
  );
  return rows;
}

/**
 * Journal Posting Preview — runs the EXACT SAME account-resolution
 * and aggregation logic postPayrollAccrual() uses, but only ever
 * SELECTs (resolveAccountCode is read-only; nothing here writes to
 * any table), so there is no side effect to worry about and nothing
 * to roll back — the transaction wrapper is used purely for a
 * consistent read snapshot, not for undo safety.
 *
 * Deliberately duplicates the aggregation rather than calling
 * postPayrollAccrual() itself with a "dry run" flag: postJournalEntry()
 * has a real side effect (sequential voucher numbering) that a preview
 * must NEVER trigger — Indian accounting practice treats voucher-
 * number gaps as a real compliance concern, so "preview, then discard"
 * must not consume one, and the only way to guarantee that is for the
 * preview to never call postJournalEntry() at all, not to call it and
 * roll back afterward.
 */
export async function journalPostingPreview(runId: number) {
  return withTransaction(async (client) => {
    const { rows: runRows } = await client.query(`select * from payroll_runs where id = $1`, [runId]);
    if (runRows.length === 0) throw new Error(`Payroll run ${runId} not found.`);

    const { rows: components } = await client.query(
      `select plc.*, pl.cost_center_id from payroll_line_components plc join payroll_lines pl on pl.id = plc.payroll_line_id where pl.payroll_run_id = $1`,
      [runId],
    );
    const { rows: lines } = await client.query(`select * from payroll_lines where payroll_run_id = $1`, [runId]);

    const preview: Array<{ accountCode: string; debit: number; credit: number; narration: string }> = [];
    const earningsByAccount = new Map<string, number>();
    const deductionByAccount = new Map<string, number>();
    const employerExpenseByAccount = new Map<string, number>();
    const employerPayableByAccount = new Map<string, number>();
    let reimbursementTotal = 0, netSalaryTotal = 0, loanTotal = 0;

    // Rounds at every accumulation step, matching postPayrollAccrual()
    // exactly — an earlier version of this function only rounded at
    // the final push, which is a real (if usually negligible)
    // divergence from "identical logic" between preview and actual
    // posting; fixed so the claim in PAYROLL_ACCOUNTING_INTEGRATION.md
    // is literally true, not just approximately true.
    const round2 = (n: number) => Math.round(n * 100) / 100;

    for (const c of components) {
      if (c.component_type === "earning") {
        const account = await resolveAccountCode(client, "SALARY_EXPENSE", { componentId: c.component_id });
        earningsByAccount.set(account, round2((earningsByAccount.get(account) ?? 0) + Number(c.amount)));
      } else if (c.component_type === "deduction") {
        const account = c.statutory_rule_id
          ? await resolveAccountCode(client, "EMPLOYEE_DEDUCTION_PAYABLE", { statutoryRuleId: c.statutory_rule_id })
          : await resolveAccountCode(client, "EMPLOYEE_DEDUCTION_PAYABLE", { componentId: c.component_id });
        deductionByAccount.set(account, round2((deductionByAccount.get(account) ?? 0) + Number(c.amount)));
      } else {
        const expenseAccount = await resolveAccountCode(client, "EMPLOYER_CONTRIBUTION_EXPENSE", { statutoryRuleId: c.statutory_rule_id });
        employerExpenseByAccount.set(expenseAccount, round2((employerExpenseByAccount.get(expenseAccount) ?? 0) + Number(c.amount)));
        const payableAccount = await resolveAccountCode(client, "EMPLOYER_CONTRIBUTION_PAYABLE", { statutoryRuleId: c.statutory_rule_id });
        employerPayableByAccount.set(payableAccount, round2((employerPayableByAccount.get(payableAccount) ?? 0) + Number(c.amount)));
      }
    }
    for (const line of lines) {
      if (Number(line.overtime_amount) > 0) {
        const account = await resolveAccountCode(client, "SALARY_EXPENSE");
        earningsByAccount.set(account, round2((earningsByAccount.get(account) ?? 0) + Number(line.overtime_amount)));
      }
      reimbursementTotal = round2(reimbursementTotal + Number(line.reimbursement_amount));
      netSalaryTotal = round2(netSalaryTotal + Number(line.net_salary));
      loanTotal = round2(loanTotal + Number(line.loan_recovery_amount));
    }

    for (const [account, amount] of earningsByAccount) if (amount > 0) preview.push({ accountCode: account, debit: amount, credit: 0, narration: "Salary expense" });
    for (const [account, amount] of employerExpenseByAccount) if (amount > 0) preview.push({ accountCode: account, debit: amount, credit: 0, narration: "Employer contribution expense" });
    if (reimbursementTotal > 0) preview.push({ accountCode: await resolveAccountCode(client, "REIMBURSEMENT_EXPENSE"), debit: reimbursementTotal, credit: 0, narration: "Reimbursements" });
    for (const [account, amount] of deductionByAccount) if (amount > 0) preview.push({ accountCode: account, debit: 0, credit: amount, narration: "Employee deductions payable" });
    for (const [account, amount] of employerPayableByAccount) if (amount > 0) preview.push({ accountCode: account, debit: 0, credit: amount, narration: "Employer contribution payable" });
    if (loanTotal > 0) preview.push({ accountCode: await resolveAccountCode(client, "LOAN_RECEIVABLE"), debit: 0, credit: loanTotal, narration: "Loan recovery" });
    preview.push({ accountCode: await resolveAccountCode(client, "NET_SALARY_PAYABLE"), debit: 0, credit: netSalaryTotal, narration: "Net salary payable" });

    const totalDebit = round2(preview.reduce((s, l) => s + l.debit, 0));
    const totalCredit = round2(preview.reduce((s, l) => s + l.credit, 0));

    return { lines: preview, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  });
}
