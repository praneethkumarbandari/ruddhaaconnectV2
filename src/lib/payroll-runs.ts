import type { PgClient } from "../db/pool.ts";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";
import { selectEligibleEmployees, calculatePayrollLine } from "./payroll-calculation.ts";

export class PayrollRunNotFoundError extends Error {
  constructor(id: number) { super(`Payroll run ${id} not found.`); this.name = "PayrollRunNotFoundError"; }
}
export class PayrollRunLockedError extends Error {
  constructor(id: number, status: string) { super(`Payroll run ${id} is '${status}' and cannot be reprocessed. Unlock it first if changes are genuinely needed.`); this.name = "PayrollRunLockedError"; }
}
export class PayrollRunNotProcessedError extends Error {
  constructor(id: number, status: string) { super(`Payroll run ${id} is '${status}' — it must be 'processed' before it can be locked.`); this.name = "PayrollRunNotProcessedError"; }
}
export class PayrollRunNotLockedError extends Error {
  constructor(id: number, status: string) { super(`Payroll run ${id} is '${status}' — only a 'locked' run can be unlocked or posted.`); this.name = "PayrollRunNotLockedError"; }
}
export class PayrollRunAlreadyPostedError extends Error {
  constructor(id: number) { super(`Payroll run ${id} has already been posted to Accounting and cannot be reopened. A correction must be a new off-cycle/arrears run.`); this.name = "PayrollRunAlreadyPostedError"; }
}
export class OverlappingPayrollRunError extends Error {
  constructor() { super("An overlapping payroll run already exists for this period and scope."); this.name = "OverlappingPayrollRunError"; }
}

export type CreatePayrollRunInput = {
  runType: "monthly" | "off_cycle" | "final_settlement" | "arrears";
  periodStart: string;
  periodEnd: string;
  branchId?: number | null;
};

export async function createPayrollRun(actorUserId: number | null, input: CreatePayrollRunInput) {
  return withTransaction(async (client) => {
    // Reject an overlapping monthly run for the same branch scope —
    // off_cycle/final_settlement/arrears runs are allowed to overlap
    // a monthly run's period (e.g. a final settlement mid-month), so
    // this check is scoped to run_type='monthly' specifically, not
    // every run type.
    if (input.runType === "monthly") {
      const { rows } = await client.query(
        `select 1 from payroll_runs
         where run_type = 'monthly' and status <> 'reopened'
           and period_start <= $2 and period_end >= $1
           and coalesce(branch_id, 0) = coalesce($3, 0)
         limit 1`,
        [input.periodStart, input.periodEnd, input.branchId ?? null],
      );
      if (rows.length > 0) throw new OverlappingPayrollRunError();
    }

    const { rows } = await client.query(
      `insert into payroll_runs (run_type, period_start, period_end, branch_id) values ($1,$2,$3,$4) returning *`,
      [input.runType, input.periodStart, input.periodEnd, input.branchId ?? null],
    );
    await writeAudit(client, { userId: actorUserId, action: "create", module: "payroll_runs", recordId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
}

async function loadRun(client: PgClient, runId: number) {
  const { rows } = await client.query(`select * from payroll_runs where id = $1`, [runId]);
  if (rows.length === 0) throw new PayrollRunNotFoundError(runId);
  const run = rows[0];
  // FIX: period_start/period_end are Postgres `date` columns, which the
  // `pg` driver returns as JS Date objects, not "YYYY-MM-DD" strings.
  // Every caller of loadRun() treats them as strings — periodTag
  // construction below did `String(run.period_end).slice(0, 7)`, which
  // on a Date object gives "Wed Feb" (from its verbose .toString()),
  // never a real "YYYY-MM" — so loan-installment recovery matching
  // `due_period` silently matched zero rows, every single run. Worse,
  // calculatePayrollLine() calls `periodEnd.slice(0, 7)` directly,
  // which throws outright on a Date object (no .slice method). Normalize
  // once here so every downstream consumer gets a real string.
  return {
    ...run,
    period_start: run.period_start instanceof Date ? run.period_start.toISOString().slice(0, 10) : run.period_start,
    period_end: run.period_end instanceof Date ? run.period_end.toISOString().slice(0, 10) : run.period_end,
  };
}

/**
 * Processes (or reprocesses) every eligible employee for this run.
 * "Reprocessing before lock" per the spec: allowed from 'draft' or
 * already-'processed' status; rejected once 'locked' or 'posted'.
 * Each employee's line is computed independently (per-employee
 * try/catch, mirroring the Attendance import engine's per-row
 * resilience fix) — one employee with a data problem (e.g. no salary
 * structure assigned) does not block payroll for everyone else.
 */
export async function processPayrollRun(
  actorUserId: number | null,
  runId: number,
  manualAdjustmentsByEmployee: Record<number, Array<{ componentId: number; componentType: "earning" | "deduction"; amount: number }>> = {},
) {
  return withTransaction(async (client) => {
    const run = await loadRun(client, runId);
    if (run.status === "locked" || run.status === "posted") throw new PayrollRunLockedError(runId, run.status);

    const employees = await selectEligibleEmployees(client, run.period_start, run.period_end, run.branch_id);

    const results: Array<{ employeeId: number; success: boolean; error?: string }> = [];
    for (const emp of employees) {
      try {
        await calculatePayrollLine(
          client, actorUserId, runId, emp.employee_id, run.period_start, run.period_end,
          manualAdjustmentsByEmployee[emp.employee_id] ?? [],
        );
        results.push({ employeeId: emp.employee_id, success: true });
      } catch (err) {
        results.push({ employeeId: emp.employee_id, success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const { rows: updatedRun } = await client.query(
      `update payroll_runs set status = 'processed', processed_by = $2, processed_at = now() where id = $1 returning *`,
      [runId, actorUserId],
    );
    await writeAudit(client, { userId: actorUserId, action: "update", module: "payroll_runs", recordId: runId, oldValue: run, newValue: { ...updatedRun[0], _processedCount: results.filter((r) => r.success).length, _failedCount: results.filter((r) => !r.success).length } });

    return { run: updatedRun[0], results };
  });
}

/**
 * Locks the run: freezes payroll_lines against further reprocessing,
 * and marks every loan installment / reimbursement claim actually
 * recovered/paid in this run's lines as such (payroll_line_id set,
 * status advanced) — this is the ONE place those become "spent,"
 * consistent with "no direct database updates" elsewhere in this
 * codebase: the lock action is what commits the recovery, not the
 * calculation preview.
 */
export async function lockPayrollRun(actorUserId: number, runId: number) {
  return withTransaction(async (client) => {
    const run = await loadRun(client, runId);
    if (run.status !== "processed") throw new PayrollRunNotProcessedError(runId, run.status);

    const { rows: lines } = await client.query(`select * from payroll_lines where payroll_run_id = $1`, [runId]);
    for (const line of lines) {
      const periodTag = run.period_end.slice(0, 7);

      const { rows: recoveredInstallments } = await client.query(
        `update loan_installments set status = 'recovered', payroll_line_id = $2, recovered_at = now()
         where loan_id in (select id from employee_loans where employee_id = $1) and due_period = $3 and status = 'pending'
         returning *`,
        [line.employee_id, line.id, periodTag],
      );
      for (const installment of recoveredInstallments) {
        await writeAudit(client, { userId: actorUserId, action: "update", module: "loan_installments", recordId: installment.id, newValue: installment });
      }

      const { rows: paidClaims } = await client.query(
        `update reimbursement_claims set status = 'paid', payroll_line_id = $2 where employee_id = $1 and status = 'approved' and payroll_line_id is null returning *`,
        [line.employee_id, line.id],
      );
      for (const claim of paidClaims) {
        await writeAudit(client, { userId: actorUserId, action: "update", module: "reimbursement_claims", recordId: claim.id, newValue: claim });
      }

      // A loan fully recovered (no more pending installments) is closed.
      const { rows: closedLoans } = await client.query(
        `update employee_loans set status = 'closed', updated_at = now()
         where employee_id = $1 and status = 'active' and not exists (select 1 from loan_installments where loan_id = employee_loans.id and status = 'pending')
         returning *`,
        [line.employee_id],
      );
      for (const loan of closedLoans) {
        await writeAudit(client, { userId: actorUserId, action: "update", module: "employee_loans", recordId: loan.id, newValue: loan });
      }
    }

    const { rows } = await client.query(`update payroll_runs set status = 'locked', locked_by = $2, locked_at = now() where id = $1 returning *`, [runId, actorUserId]);
    await writeAudit(client, { userId: actorUserId, action: "update", module: "payroll_runs", recordId: runId, oldValue: run, newValue: rows[0] });
    return rows[0];
  });
}

/**
 * Reopens a locked (but not yet posted) run — "authorized users only"
 * per the spec, enforced by the route's payroll.unlock permission
 * (a separate, stricter permission than payroll.process). Reverses
 * lockPayrollRun's loan/reimbursement commitments back to pending, so
 * a subsequent reprocess-and-relock is safe to run again rather than
 * double-counting an already-committed recovery. Each reversal is
 * audited individually, same as the lock action's own commitments —
 * an unlock that silently reverted loan/reimbursement state with no
 * trail would be exactly the kind of gap that undermines "Loan
 * Recovery must be audited."
 */
export async function unlockPayrollRun(actorUserId: number, runId: number, reopenReason: string) {
  return withTransaction(async (client) => {
    const run = await loadRun(client, runId);
    if (run.status !== "locked") throw new PayrollRunNotLockedError(runId, run.status);
    if (run.posted_at) throw new PayrollRunAlreadyPostedError(runId);

    const { rows: lines } = await client.query(`select id from payroll_lines where payroll_run_id = $1`, [runId]);
    for (const line of lines) {
      const { rows: revertedInstallments } = await client.query(`update loan_installments set status = 'pending', payroll_line_id = null, recovered_at = null where payroll_line_id = $1 returning *`, [line.id]);
      for (const installment of revertedInstallments) {
        await writeAudit(client, { userId: actorUserId, action: "update", module: "loan_installments", recordId: installment.id, newValue: { ...installment, _event: "reverted_by_unlock" } });
      }
      const { rows: revertedClaims } = await client.query(`update reimbursement_claims set status = 'approved', payroll_line_id = null where payroll_line_id = $1 returning *`, [line.id]);
      for (const claim of revertedClaims) {
        await writeAudit(client, { userId: actorUserId, action: "update", module: "reimbursement_claims", recordId: claim.id, newValue: { ...claim, _event: "reverted_by_unlock" } });
      }
    }

    const { rows } = await client.query(
      `update payroll_runs set status = 'reopened', reopened_by = $2, reopened_at = now(), reopen_reason = $3 where id = $1 returning *`,
      [runId, actorUserId, reopenReason],
    );
    await writeAudit(client, { userId: actorUserId, action: "update", module: "payroll_runs", recordId: runId, oldValue: run, newValue: rows[0] });
    return rows[0];
  });
}

export async function getPayrollRun(runId: number) {
  const run = await query(`select * from payroll_runs where id = $1`, [runId]);
  if (run.rows.length === 0) throw new PayrollRunNotFoundError(runId);
  const lines = await query(
    `select pl.*, e.employee_name, em.employee_code from payroll_lines pl
     join employees e on e.id = pl.employee_id join employee_master em on em.employee_id = pl.employee_id
     where pl.payroll_run_id = $1 order by em.employee_code`,
    [runId],
  );
  return { run: run.rows[0], lines: lines.rows };
}

export async function listPayrollRuns(filters: { status?: string; runType?: string } = {}) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  if (filters.runType) { params.push(filters.runType); conditions.push(`run_type = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(`select * from payroll_runs ${where} order by period_start desc`, params);
  return rows;
}

export async function getPayrollLineDetail(lineId: number) {
  const { rows: lineRows } = await query(
    `select pl.*, e.employee_name, em.employee_code from payroll_lines pl
     join employees e on e.id = pl.employee_id join employee_master em on em.employee_id = pl.employee_id
     where pl.id = $1`,
    [lineId],
  );
  if (lineRows.length === 0) return null;
  const { rows: components } = await query(
    `select plc.*, sc.component_code, sc.component_name, sr.rule_code, sr.rule_name
     from payroll_line_components plc
     left join salary_components sc on sc.id = plc.component_id
     left join statutory_rules sr on sr.id = plc.statutory_rule_id
     where plc.payroll_line_id = $1`,
    [lineId],
  );
  return { ...lineRows[0], components };
}
