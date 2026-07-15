import type { PgClient } from "../db/pool.ts";

export class FinancialYearClosedError extends Error {
  constructor(fyCode: string) {
    super(`Financial year ${fyCode} is not open. Postings are not accepted.`);
    this.name = "FinancialYearClosedError";
  }
}

export class PeriodLockedError extends Error {
  constructor(fyCode: string, lockedThroughDate: string) {
    super(
      `${fyCode} has its accounting period locked through ${lockedThroughDate}. ` +
        `Postings dated on or before that date are not accepted, even though the financial year itself is still open.`,
    );
    this.name = "PeriodLockedError";
  }
}

export class NoFinancialYearError extends Error {
  constructor(date: string) {
    super(`No financial year covers ${date}.`);
    this.name = "NoFinancialYearError";
  }
}

/**
 * Finds the financial year that contains `entryDate` and confirms it
 * is open AND that entryDate isn't inside a locked interim period.
 * Every posting path must call this before writing anything — per the
 * accounting philosophy, "only an open, unlocked period accepts
 * postings" is not optional.
 */
export async function requireOpenFinancialYear(
  client: PgClient,
  entryDate: string,
): Promise<{ id: number; code: string }> {
  const { rows } = await client.query(
    `select id, code, status, locked_through_date
     from financial_years
     where $1::date between start_date and end_date`,
    [entryDate],
  );

  if (rows.length === 0) {
    throw new NoFinancialYearError(entryDate);
  }

  const fy = rows[0];
  if (fy.status !== "open") {
    throw new FinancialYearClosedError(fy.code);
  }
  if (fy.locked_through_date && entryDate <= fy.locked_through_date) {
    throw new PeriodLockedError(fy.code, fy.locked_through_date);
  }

  return { id: fy.id, code: fy.code };
}
