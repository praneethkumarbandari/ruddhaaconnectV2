import type { PgClient } from "../db/pool.ts";
import { postJournalEntry, type PostingLineInput } from "./posting-engine.ts";
import { resolveAccountCode } from "./payroll-accounts.ts";
import { PayrollRunNotLockedError } from "./payroll-runs.ts";
import { writeAudit } from "./audit.ts";

export class PayrollAlreadyPaidError extends Error {
  constructor(runId: number) { super(`Payroll run ${runId} has already had its payment posted.`); this.name = "PayrollAlreadyPaidError"; }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Posts the ACCRUAL entry for a locked run — Dr salary/employer-
 * contribution/reimbursement expense, Cr the various payables. This
 * is the ONLY function in Payroll that calls postJournalEntry();
 * nothing here ever inserts into journal_entries/journal_entry_lines
 * directly.
 *
 * Balance proof (worked through explicitly here, not just asserted,
 * because getting a payroll accrual entry wrong is exactly the kind
 * of bug that's invisible until someone reconciles the books):
 *   netSalary = grossEarnings - (structureDeductions + statutoryEmployeeShare) - loanRecovery + reimbursement
 * So Cr NET_SALARY_PAYABLE (= sum of netSalary) already contains the
 * reimbursement amount — reimbursement must NOT also get its own
 * separate payable credit line, or it would be double-counted and the
 * entry would fail postJournalEntry()'s own balance validation (which
 * is the real, live safety net here — if this arithmetic were wrong,
 * posting would fail loudly with UnbalancedEntryError, not silently
 * corrupt the ledger). Reimbursement's expense recognition (Dr
 * REIMBURSEMENT_EXPENSE) is therefore balanced by NET_SALARY_PAYABLE,
 * not by REIMBURSEMENT_PAYABLE — that mapping key exists in the
 * schema for future per-tenant customization (e.g. paying
 * reimbursements on a different cycle than salary) but is
 * deliberately NOT used by this default posting logic. Documented in
 * full in PAYROLL_ACCOUNTING_INTEGRATION.md.
 */
export async function postPayrollAccrual(client: PgClient, actorUserId: number | null, runId: number) {
  const { rows: runRows } = await client.query(`select * from payroll_runs where id = $1`, [runId]);
  const run = runRows[0];
  if (run.status !== "locked") throw new PayrollRunNotLockedError(runId, run.status);
  if (run.accrual_journal_entry_id) throw new Error(`Payroll run ${runId} has already been posted (journal entry ${run.accrual_journal_entry_id}).`);

  const { rows: lines } = await client.query(`select * from payroll_lines where payroll_run_id = $1`, [runId]);
  if (lines.length === 0) throw new Error(`Payroll run ${runId} has no payroll lines to post.`);

  const { rows: components } = await client.query(
    `select plc.*, pl.cost_center_id from payroll_line_components plc join payroll_lines pl on pl.id = plc.payroll_line_id where pl.payroll_run_id = $1`,
    [runId],
  );

  // Group earnings by (resolved expense account, cost center) — the
  // one place this posting deliberately breaks out cost-center detail,
  // since "Cost Center Payroll Summary" is an explicitly required
  // report and salary expense is the one figure that meaningfully
  // varies by cost center.
  const earningsByAccountAndCC = new Map<string, number>();
  const employerContribByAccountAndCC = new Map<string, number>();
  const deductionPayableByAccount = new Map<string, number>();
  const employerPayableByAccount = new Map<string, number>();
  let reimbursementExpenseTotal = 0;
  let netSalaryPayableTotal = 0;
  let loanReceivableTotal = 0;

  for (const c of components) {
    const costCenterId = c.cost_center_id ?? "none";
    if (c.component_type === "earning") {
      const account = await resolveAccountCode(client, "SALARY_EXPENSE", { componentId: c.component_id });
      const key = `${account}::${costCenterId}`;
      earningsByAccountAndCC.set(key, round2((earningsByAccountAndCC.get(key) ?? 0) + Number(c.amount)));
    } else if (c.component_type === "deduction") {
      const account = c.statutory_rule_id
        ? await resolveAccountCode(client, "EMPLOYEE_DEDUCTION_PAYABLE", { statutoryRuleId: c.statutory_rule_id })
        : await resolveAccountCode(client, "EMPLOYEE_DEDUCTION_PAYABLE", { componentId: c.component_id });
      deductionPayableByAccount.set(account, round2((deductionPayableByAccount.get(account) ?? 0) + Number(c.amount)));
    } else if (c.component_type === "employer_contribution") {
      const expenseAccount = await resolveAccountCode(client, "EMPLOYER_CONTRIBUTION_EXPENSE", { statutoryRuleId: c.statutory_rule_id });
      const expenseKey = `${expenseAccount}::${costCenterId}`;
      employerContribByAccountAndCC.set(expenseKey, round2((employerContribByAccountAndCC.get(expenseKey) ?? 0) + Number(c.amount)));

      const payableAccount = await resolveAccountCode(client, "EMPLOYER_CONTRIBUTION_PAYABLE", { statutoryRuleId: c.statutory_rule_id });
      employerPayableByAccount.set(payableAccount, round2((employerPayableByAccount.get(payableAccount) ?? 0) + Number(c.amount)));
    }
  }

  for (const line of lines) {
    // Overtime has no payroll_line_components row (see
    // lib/payroll-calculation.ts's note) — folded into the default
    // SALARY_EXPENSE account here instead, keyed by this line's cost center.
    if (Number(line.overtime_amount) > 0) {
      const account = await resolveAccountCode(client, "SALARY_EXPENSE");
      const key = `${account}::${line.cost_center_id ?? "none"}`;
      earningsByAccountAndCC.set(key, round2((earningsByAccountAndCC.get(key) ?? 0) + Number(line.overtime_amount)));
    }
    reimbursementExpenseTotal = round2(reimbursementExpenseTotal + Number(line.reimbursement_amount));
    netSalaryPayableTotal = round2(netSalaryPayableTotal + Number(line.net_salary));
    loanReceivableTotal = round2(loanReceivableTotal + Number(line.loan_recovery_amount));
  }

  const linesOut: PostingLineInput[] = [];
  for (const [key, amount] of earningsByAccountAndCC) {
    if (amount <= 0) continue;
    const [account] = key.split("::");
    linesOut.push({ accountCode: account, debit: amount, credit: 0, narration: `Payroll ${run.period_start} to ${run.period_end} — salary expense` });
  }
  for (const [key, amount] of employerContribByAccountAndCC) {
    if (amount <= 0) continue;
    const [account] = key.split("::");
    linesOut.push({ accountCode: account, debit: amount, credit: 0, narration: `Payroll ${run.period_start} to ${run.period_end} — employer contribution expense` });
  }
  if (reimbursementExpenseTotal > 0) {
    const account = await resolveAccountCode(client, "REIMBURSEMENT_EXPENSE");
    linesOut.push({ accountCode: account, debit: reimbursementExpenseTotal, credit: 0, narration: `Payroll ${run.period_start} to ${run.period_end} — reimbursements` });
  }
  for (const [account, amount] of deductionPayableByAccount) {
    if (amount <= 0) continue;
    linesOut.push({ accountCode: account, debit: 0, credit: amount, narration: `Payroll ${run.period_start} to ${run.period_end} — employee deductions payable` });
  }
  for (const [account, amount] of employerPayableByAccount) {
    if (amount <= 0) continue;
    linesOut.push({ accountCode: account, debit: 0, credit: amount, narration: `Payroll ${run.period_start} to ${run.period_end} — employer contribution payable` });
  }
  if (loanReceivableTotal > 0) {
    const account = await resolveAccountCode(client, "LOAN_RECEIVABLE");
    linesOut.push({ accountCode: account, debit: 0, credit: loanReceivableTotal, narration: `Payroll ${run.period_start} to ${run.period_end} — loan recovery` });
  }
  const netSalaryAccount = await resolveAccountCode(client, "NET_SALARY_PAYABLE");
  linesOut.push({ accountCode: netSalaryAccount, debit: 0, credit: netSalaryPayableTotal, narration: `Payroll ${run.period_start} to ${run.period_end} — net salary payable` });

  const posted = await postJournalEntry(client, {
    entryDate: run.period_end,
    narration: `Payroll accrual — ${run.run_type} — ${run.period_start} to ${run.period_end}`,
    sourceType: "payroll",
    sourceId: runId,
    lines: linesOut,
    userId: actorUserId,
  });

  const { rows: updated } = await client.query(
    `update payroll_runs set status = 'posted', accrual_journal_entry_id = $2, posted_by = $3, posted_at = now() where id = $1 returning *`,
    [runId, posted.id, actorUserId],
  );
  // postJournalEntry() above already audits the journal entry itself
  // (module='journal_entry') — this is a separate, additional entry
  // specifically for the PAYROLL RUN's own state transition, matching
  // every other run-lifecycle action (create/process/lock/unlock) in
  // lib/payroll-runs.ts, all of which audit under module='payroll_runs'.
  // Without this, "Posting" (explicitly required to be audited per
  // the spec) would only be visible by cross-referencing the
  // accounting audit trail, not HR's own.
  await writeAudit(client, { userId: actorUserId, action: "post", module: "payroll_runs", recordId: runId, newValue: { ...updated[0], journalEntryNo: posted.jeNo } });
  return { journalEntryId: posted.id, journalEntryNo: posted.jeNo, run: updated[0] };
}

/**
 * Posts the SETTLEMENT entry (Dr net salary payable, Cr bank) once
 * the actual bank transfer has happened — the same two-step
 * accrual-then-settlement shape this codebase's Sales/Purchase
 * modules already use (invoice, then a separate receipt/payment),
 * not a new posting pattern invented for Payroll.
 */
export async function postPayrollPayment(client: PgClient, actorUserId: number | null, runId: number) {
  const { rows: runRows } = await client.query(`select * from payroll_runs where id = $1`, [runId]);
  const run = runRows[0];
  if (!run.accrual_journal_entry_id) throw new Error(`Payroll run ${runId} must be posted (accrual) before its payment can be posted.`);
  if (run.payment_journal_entry_id) throw new PayrollAlreadyPaidError(runId);

  const { rows: totalRows } = await client.query(`select coalesce(sum(net_salary), 0) as total from payroll_lines where payroll_run_id = $1`, [runId]);
  const total = Number(totalRows[0].total);

  const netSalaryAccount = await resolveAccountCode(client, "NET_SALARY_PAYABLE");
  const bankAccount = await resolveAccountCode(client, "BANK_ACCOUNT");

  const posted = await postJournalEntry(client, {
    entryDate: new Date().toISOString().slice(0, 10),
    narration: `Payroll payment — ${run.run_type} — ${run.period_start} to ${run.period_end}`,
    sourceType: "payroll_payment",
    sourceId: runId,
    lines: [
      { accountCode: netSalaryAccount, debit: total, credit: 0, narration: "Net salary payable settled" },
      { accountCode: bankAccount, debit: 0, credit: total, narration: "Bank transfer" },
    ],
    userId: actorUserId,
  });

  await client.query(`update payroll_runs set payment_journal_entry_id = $2 where id = $1`, [runId, posted.id]);
  await writeAudit(client, { userId: actorUserId, action: "update", module: "payroll_runs", recordId: runId, newValue: { paymentJournalEntryId: posted.id, journalEntryNo: posted.jeNo } });
  return { journalEntryId: posted.id, journalEntryNo: posted.jeNo };
}
