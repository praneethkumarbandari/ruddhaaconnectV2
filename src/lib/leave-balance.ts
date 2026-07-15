import type { PgClient } from "../db/pool.ts";
import { withTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";
import { toIsoDate } from "./attendance.ts";

/**
 * Leave balance ledger. Deliberately mirrors this codebase's own
 * accounting philosophy (journal_entries as the single source of
 * truth; a balance is always `sum(...)`, never a stored, mutable
 * number) — this is exactly what the spec's "never overwrite
 * historical balances" / "maintain complete audit history"
 * requirements amount to, and this codebase already has a proven
 * pattern for it. `leave_balance_transactions` is the ledger;
 * "closing balance" is always computed by summing, never stored.
 */

export class InsufficientLeaveBalanceError extends Error {
  constructor(available: number, requested: number) {
    super(`Insufficient leave balance: ${available} day(s) available, ${requested} requested.`);
    this.name = "InsufficientLeaveBalanceError";
  }
}

export class LeavePolicyNotFoundError extends Error {
  constructor(leaveTypeId: number) {
    super(`No leave policy configured for leave type ${leaveTypeId}.`);
    this.name = "LeavePolicyNotFoundError";
  }
}

/** Which calendar year's leave-year period `date` falls into, per the single active leave_year_configurations row. Returns the year the period STARTS in (e.g. an April-start config, for a date in Feb 2026, returns 2025 — the "2025-26" leave year). */
export async function getLeaveYearForDate(client: PgClient, date: string | Date): Promise<number> {
  const { rows } = await client.query(`select start_month, start_day from leave_year_configurations where is_active = true limit 1`);
  const config = rows[0] ?? { start_month: 1, start_day: 1 };
  // FIX: some callers pass a request-body string (already safe); others
  // (finalizeLeaveApproval, cancellation) pass a raw DB row's from_date
  // straight from `select *` — a Postgres `date` column, which `pg`
  // returns as a JS Date object. `date.split("-")` on that threw
  // outright ("date.split is not a function"), crashing final-level
  // leave approval and reversal on cancellation. Same bug class as
  // enumerateDates() in this same file.
  const dateStr = date instanceof Date ? date.toISOString().slice(0, 10) : date;
  const [year, month, day] = dateStr.split("-").map(Number);
  const candidateStart = `${year}-${String(config.start_month).padStart(2, "0")}-${String(config.start_day).padStart(2, "0")}`;
  return dateStr >= candidateStart ? year : year - 1;
}

export async function getLeavePolicy(client: PgClient, leaveTypeId: number) {
  const { rows } = await client.query(
    `select lp.*, lt.leave_type_code, lt.leave_type_name, lt.default_annual_days, lt.allow_carry_forward, lt.max_carry_forward_days, lt.allow_encashment
     from leave_policies lp join leave_types lt on lt.id = lp.leave_type_id
     where lp.leave_type_id = $1 and lp.is_active = true`,
    [leaveTypeId],
  );
  if (rows.length === 0) throw new LeavePolicyNotFoundError(leaveTypeId);
  return rows[0];
}

/** Sum of all ledger entries for (employee, leave type, leave year) — the closing balance, always derived, never stored. */
export async function getLeaveBalance(client: PgClient, employeeId: number, leaveTypeId: number, leaveYear: number): Promise<number> {
  const { rows } = await client.query(
    `select coalesce(sum(days), 0) as balance from leave_balance_transactions where employee_id = $1 and leave_type_id = $2 and leave_year = $3`,
    [employeeId, leaveTypeId, leaveYear],
  );
  return Number(rows[0].balance);
}

export type PostLedgerInput = {
  employeeId: number;
  leaveTypeId: number;
  leaveYear: number;
  transactionType: "opening_balance" | "accrual" | "consumption" | "carry_forward" | "encashment" | "expiry" | "manual_adjustment";
  days: number;
  referenceType?: "leave_request" | "manual" | "system" | null;
  referenceId?: number | null;
  remarks?: string | null;
};

/** The one function that writes to the ledger. Never updates or deletes an existing row — every balance change is a new row, which is the entire mechanism behind "never overwrite historical balances." */
export async function postLeaveBalanceTransaction(client: PgClient, actorUserId: number | null, input: PostLedgerInput) {
  const { rows } = await client.query(
    `insert into leave_balance_transactions (employee_id, leave_type_id, leave_year, transaction_type, days, reference_type, reference_id, remarks, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [input.employeeId, input.leaveTypeId, input.leaveYear, input.transactionType, input.days, input.referenceType ?? null, input.referenceId ?? null, input.remarks ?? null, actorUserId],
  );
  await writeAudit(client, {
    userId: actorUserId,
    action: "create",
    module: "leave_balance_transactions",
    recordId: rows[0].id,
    newValue: rows[0],
  });
  return rows[0];
}

/**
 * Runs accrual for one leave type + leave year, either for one
 * employee or every employee currently eligible (active,
 * employee_master exists, past probation if the policy restricts
 * accrual during probation — reusing the same probation flag the
 * application-time validation uses, so "can this employee use the
 * leave type" and "does this employee accrue it" stay consistent
 * rather than being two independently-maintained rules).
 *
 * No scheduler exists in this codebase (Netlify Functions has no
 * background job infrastructure) — this is an explicit administrative
 * trigger (HR calls this monthly/annually as their policy requires),
 * not an automatic cron. Documented as a known operational reality,
 * not silently assumed to run itself.
 *
 * Pro-rates for employees who joined mid-period: accrual granted is
 * `default_annual_days / periodsPerYear`, scaled by the fraction of
 * the period they were actually employed for, based on joining_date.
 * This is a reasonable, disclosed simplification — it does not
 * attempt mid-period exit pro-ration (an employee who exits mid-period
 * still gets the full period's accrual up to their last day), since
 * exit-time balance settlement is a real, separate business decision
 * (final settlement, encashment of remaining balance) that this
 * milestone doesn't presume to automate.
 */
export async function runAccrualBatch(
  actorUserId: number | null,
  leaveTypeId: number,
  leaveYear: number,
  periodStart: string,
  periodEnd: string,
  periodsPerYear: number,
  employeeIds?: number[],
) {
  return withTransaction(async (client) => {
    const policy = await getLeavePolicy(client, leaveTypeId);

    const { rows: employees } = await client.query(
      employeeIds && employeeIds.length > 0
        ? `select employee_id, joining_date from employee_master where employee_id = any($1::bigint[]) and status in ('active','on_notice')`
        : `select employee_id, joining_date from employee_master where status in ('active','on_notice')`,
      employeeIds && employeeIds.length > 0 ? [employeeIds] : [],
    );

    const results: Array<{ employeeId: number; days: number; skipped?: string }> = [];
    for (const emp of employees) {
      const joiningDate = toIsoDate(emp.joining_date);
      if (joiningDate > periodEnd) {
        results.push({ employeeId: emp.employee_id, days: 0, skipped: "joins after this accrual period" });
        continue;
      }
      if (policy.probation_period_days > 0 && !policy.allow_during_probation) {
        const probationEndDate = addDays(joiningDate, policy.probation_period_days);
        if (probationEndDate > periodEnd) {
          results.push({ employeeId: emp.employee_id, days: 0, skipped: "still within probation for this leave type" });
          continue;
        }
      }

      const fullPeriodAccrual = Number(policy.default_annual_days) / periodsPerYear;
      const effectiveStart = joiningDate > periodStart ? joiningDate : periodStart;
      const periodLengthDays = daysBetween(periodStart, periodEnd) + 1;
      const employedDays = daysBetween(effectiveStart, periodEnd) + 1;
      const proratedDays = Math.round((fullPeriodAccrual * (employedDays / periodLengthDays)) * 100) / 100;

      if (proratedDays <= 0) {
        results.push({ employeeId: emp.employee_id, days: 0, skipped: "prorated accrual rounds to zero" });
        continue;
      }

      await postLeaveBalanceTransaction(client, actorUserId, {
        employeeId: emp.employee_id,
        leaveTypeId,
        leaveYear,
        transactionType: "accrual",
        days: proratedDays,
        referenceType: "system",
        remarks: `Accrual for period ${periodStart} to ${periodEnd}${employedDays < periodLengthDays ? " (pro-rated for mid-period joining)" : ""}.`,
      });
      results.push({ employeeId: emp.employee_id, days: proratedDays });
    }
    return results;
  });
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr: string, toStr: string): number {
  const from = new Date(`${fromStr}T00:00:00Z`);
  const to = new Date(`${toStr}T00:00:00Z`);
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}
