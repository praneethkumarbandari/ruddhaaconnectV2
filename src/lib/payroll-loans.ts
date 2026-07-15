import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";

export class LoanNotFoundError extends Error {
  constructor(id: number) { super(`Loan ${id} not found.`); this.name = "LoanNotFoundError"; }
}
export class LoanNotActiveError extends Error {
  constructor(id: number, status: string) { super(`Loan ${id} is '${status}' — only an 'active' loan can be adjusted or settled.`); this.name = "LoanNotActiveError"; }
}

export type CreateLoanInput = {
  employeeId: number;
  loanType: "loan" | "advance";
  principalAmount: number;
  interestRate?: number;
  emiAmount: number;
  numberOfInstallments: number;
  disbursedDate: string;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Creates the loan AND its full installment schedule in one
 * transaction — a loan with no installments is an incomplete,
 * unrecoverable record, so there is no separate "generate schedule"
 * step to forget. due_period assigns each installment to the
 * calendar month following disbursement, one per month — a simple,
 * disclosed convention (no support yet for a custom recovery
 * calendar, e.g. skipping a month) since nothing has required one.
 * Interest is split evenly across installments as a straight-line
 * approximation, not a reducing-balance amortization schedule — a
 * real, disclosed simplification (see PAYROLL_CALCULATION.md).
 */
export async function createLoan(actorUserId: number | null, input: CreateLoanInput) {
  return withTransaction(async (client) => {
    const { rows: empRows } = await client.query(`select 1 from employee_master where employee_id = $1`, [input.employeeId]);
    if (empRows.length === 0) throw new Error(`Employee ${input.employeeId} has no employee_master record.`);

    const { rows } = await client.query(
      `insert into employee_loans (employee_id, loan_type, principal_amount, interest_rate, emi_amount, number_of_installments, disbursed_date)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [input.employeeId, input.loanType, input.principalAmount, input.interestRate ?? 0, input.emiAmount, input.numberOfInstallments, input.disbursedDate],
    );
    const loan = rows[0];

    const totalInterest = round2(input.principalAmount * (input.interestRate ?? 0) / 100);
    const interestPerInstallment = round2(totalInterest / input.numberOfInstallments);
    const principalPerInstallment = round2(input.principalAmount / input.numberOfInstallments);

    const disbursedParts = input.disbursedDate.split("-").map(Number);
    const disYear = disbursedParts[0];
    const disMonth = disbursedParts[1]; // 1-12

    for (let i = 1; i <= input.numberOfInstallments; i++) {
      // Pure integer year/month arithmetic — deliberately NOT
      // `new Date(...).setUTCMonth(...)`. That approach has a real
      // bug for a loan disbursed on the 29th-31st of a month: JS
      // Date's day-of-month rollover means Jan 31 + 1 month becomes
      // March 2nd or 3rd (February doesn't have 31 days), silently
      // skipping February and misassigning which payroll period the
      // installment is due in. Never touching day-of-month at all
      // avoids the entire bug class.
      const totalMonths = (disMonth - 1) + i;
      const targetYear = disYear + Math.floor(totalMonths / 12);
      const targetMonth = (totalMonths % 12) + 1;
      const duePeriod = `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
      const isLast = i === input.numberOfInstallments;
      await client.query(
        `insert into loan_installments (loan_id, installment_number, due_period, emi_amount, principal_component, interest_component)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          loan.id, i, duePeriod, input.emiAmount,
          // last installment absorbs any rounding remainder so the
          // schedule sums exactly to principalAmount, not slightly under/over.
          isLast ? round2(input.principalAmount - principalPerInstallment * (input.numberOfInstallments - 1)) : principalPerInstallment,
          interestPerInstallment,
        ],
      );
    }

    await writeAudit(client, { userId: actorUserId, action: "create", module: "employee_loans", recordId: loan.id, newValue: loan });
    return loan;
  });
}

export async function getLoan(loanId: number) {
  const { rows: loanRows } = await query(`select * from employee_loans where id = $1`, [loanId]);
  if (loanRows.length === 0) throw new LoanNotFoundError(loanId);
  const { rows: installments } = await query(`select * from loan_installments where loan_id = $1 order by installment_number`, [loanId]);
  const outstanding = installments.filter((i) => i.status === "pending").reduce((sum, i) => sum + Number(i.emi_amount), 0);
  return { ...loanRows[0], installments, outstandingBalance: round2(outstanding) };
}

export async function listLoans(filters: { employeeId?: number; status?: string }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.employeeId) { params.push(filters.employeeId); conditions.push(`employee_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(`select * from employee_loans ${where} order by disbursed_date desc`, params);
  return rows;
}

/** Manual settlement — waives all remaining pending installments (e.g. a final settlement paying off the balance in one lump sum outside payroll recovery). */
export async function settleLoan(actorUserId: number, loanId: number, settlementNotes: string) {
  return withTransaction(async (client) => {
    const { rows: loanRows } = await client.query(`select * from employee_loans where id = $1`, [loanId]);
    if (loanRows.length === 0) throw new LoanNotFoundError(loanId);
    if (loanRows[0].status !== "active") throw new LoanNotActiveError(loanId, loanRows[0].status);

    await client.query(`update loan_installments set status = 'waived' where loan_id = $1 and status = 'pending'`, [loanId]);
    const { rows } = await client.query(`update employee_loans set status = 'settled', updated_at = now() where id = $1 returning *`, [loanId]);
    await writeAudit(client, { userId: actorUserId, action: "update", module: "employee_loans", recordId: loanId, oldValue: loanRows[0], newValue: { ...rows[0], settlementNotes } });
    return rows[0];
  });
}
