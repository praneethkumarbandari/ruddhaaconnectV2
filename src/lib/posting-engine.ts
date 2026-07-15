import type { PgClient } from "../db/pool.ts";
import { nextDocumentNumber } from "./number-generator.ts";
import { requireOpenFinancialYear } from "./fy.ts";
import { writeAudit } from "./audit.ts";

export type PostingLineInput = {
  accountCode: string;
  debit: number;
  credit: number;
  narration?: string;
  partyType?: "customer" | "vendor";
  partyId?: number;
};

export type JournalEntryInput = {
  entryDate: string;        // 'YYYY-MM-DD'
  narration: string;
  sourceType:
    | "manual"
    | "invoice"
    | "purchase"
    | "receipt"
    | "payment"
    | "reversal"
    | "opening_balance"
    | "contra"
    | "credit_note"
    | "debit_note"
    // Milestone 5 (Payroll) addition — see
    // PAYROLL_ACCOUNTING_INTEGRATION.md "The One Necessary Accounting
    // Change" for the full issue/impact/migration/regression-risk
    // writeup. This is a TypeScript-level addition to a union type
    // only: journal_entries.source_type is `text` with no DB-level
    // CHECK constraint (confirmed by reading schema.sql before making
    // this change), so no migration, no constraint to alter, and no
    // risk to any existing row of any source_type. 'payroll' is the
    // accrual entry (Dr salary expense/employer contributions, Cr
    // payables) at payroll posting; 'payroll_payment' is the separate
    // settlement entry (Dr net salary payable, Cr bank) when the
    // actual bank transfer happens — mirroring this codebase's own
    // existing invoice-then-receipt / purchase-then-payment two-step
    // pattern, not a new posting shape invented for Payroll.
    | "payroll"
    | "payroll_payment"
    // Bank & Cash architecture migration addition — see
    // Architecture Migration Report "Bank & Cash". A bank transaction
    // mapped to Expense/Income/Transfer/Loan/Capital/Adjustment (i.e.
    // NOT a customer/vendor, which go through receipts.ts/payments.ts
    // instead) has no document table of its own — same situation
    // Contra and manual JE were already in — so it posts straight
    // through postJournalEntry() with this source type, exactly like
    // 'manual' does, just tagged distinctly so a bank-originated
    // journal entry is identifiable in reports later. Same
    // no-migration-needed reasoning as 'payroll' above: source_type is
    // untyped `text` at the DB level.
    | "bank_mapping"
    // FIX: real gap found in production — creating a bank account
    // with a nonzero opening balance only ever wrote that number to
    // bank_accounts.opening_balance (a plain display field), never
    // posted any actual journal entry. Balance Sheet/Trial Balance/
    // P&L are all derived strictly from posted journal_entry_lines
    // (by design — reports are never stored, always derived), so a
    // bank account's opening balance never appeared there at all,
    // even though Bank & Cash's own summary correctly showed it.
    // Deliberately its own sourceType rather than reusing
    // "opening_balance" — that value is checked once-per-financial-
    // year by postOpeningBalances() (source_type='opening_balance'
    // AND source_id=financialYearId); reusing it here with
    // source_id=bankAccountId risked a false "already posted" collision
    // if a bank account's id ever numerically matched a financial
    // year's id. A distinct value removes that risk entirely.
    | "bank_account_opening";
  sourceId?: number;
  // Project Management integration: only Contra and manual Journal
  // Entries have no separate document table of their own to carry a
  // project tag, so it's threaded through here for exactly those two
  // callers. Every other transaction type (invoices, receipts,
  // payments, notes) keeps project_id on its own document row instead
  // — never duplicated onto the journal header too. This field is
  // never read by any validation/balancing logic below; it's a
  // passive value stored on the journal_entries row for later
  // reporting only.
  projectId?: number | null;
  lines: PostingLineInput[];
  userId: number | null;
  ipAddress?: string | null;
};

export class UnbalancedEntryError extends Error {
  constructor(debitTotal: number, creditTotal: number) {
    super(`Entry does not balance: debit ${debitTotal} != credit ${creditTotal}`);
    this.name = "UnbalancedEntryError";
  }
}

export class InsufficientLinesError extends Error {
  constructor() {
    super("A journal entry needs at least two lines.");
    this.name = "InsufficientLinesError";
  }
}

export class UnknownAccountError extends Error {
  constructor(code: string) {
    super(`Account code "${code}" does not exist or is inactive.`);
    this.name = "UnknownAccountError";
  }
}

/** Round to paise/cents to avoid floating-point false negatives on the balance check. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function validateBalance(lines: PostingLineInput[]): void {
  if (lines.length < 2) throw new InsufficientLinesError();

  const debitTotal = round2(lines.reduce((sum, l) => sum + l.debit, 0));
  const creditTotal = round2(lines.reduce((sum, l) => sum + l.credit, 0));

  if (debitTotal !== creditTotal) {
    throw new UnbalancedEntryError(debitTotal, creditTotal);
  }

  for (const line of lines) {
    if (line.debit > 0 && line.credit > 0) {
      throw new Error(`Line for ${line.accountCode} has both a debit and a credit — only one is allowed.`);
    }
    if (line.debit === 0 && line.credit === 0) {
      throw new Error(`Line for ${line.accountCode} has no amount.`);
    }
  }
}

/**
 * The posting engine. This is the ONLY function in the entire backend
 * that is allowed to insert into journal_entries / journal_entry_lines.
 * Every module (invoices, purchases, receipts, payments, manual JE)
 * must construct a JournalEntryInput and call this — never write to
 * those tables directly.
 *
 * Sequence, matching the accounting philosophy exactly:
 *   Validation -> Financial Year check -> Voucher number -> Journal
 *   -> Ledger (implicit: journal_entry_lines IS the ledger source)
 *   -> Audit -> Posted
 *
 * Runs entirely inside the caller's transaction (`client`). If any
 * step throws, the caller's withTransaction() wrapper rolls back
 * everything — there is no such thing as a partially posted entry.
 */
export async function postJournalEntry(
  client: PgClient,
  input: JournalEntryInput,
): Promise<{ id: number; jeNo: string }> {
  // 1. Validation
  validateBalance(input.lines);

  // 2. Financial year check
  const fy = await requireOpenFinancialYear(client, input.entryDate);

  // 3. Resolve account codes to ids, and confirm every account is active.
  const resolvedLines: Array<PostingLineInput & { accountId: number }> = [];
  for (const line of input.lines) {
    const { rows } = await client.query(
      `select id from chart_of_accounts where account_code = $1 and is_active = true`,
      [line.accountCode],
    );
    if (rows.length === 0) throw new UnknownAccountError(line.accountCode);
    resolvedLines.push({ ...line, accountId: rows[0].id });
  }

  // 4. Voucher number (atomic, financial-year-scoped)
  const jeNo = await nextDocumentNumber(client, "journal_entry", fy.id);

  // 5. Journal header
  const { rows: jeRows } = await client.query(
    `insert into journal_entries
       (je_no, financial_year_id, entry_date, narration, source_type, source_id, status, posted_at, posted_by, project_id)
     values ($1, $2, $3, $4, $5, $6, 'posted', now(), $7, $8)
     returning id`,
    [jeNo, fy.id, input.entryDate, input.narration, input.sourceType, input.sourceId ?? null, input.userId, input.projectId ?? null],
  );
  const journalEntryId = jeRows[0].id;

  // 6. Ledger — journal_entry_lines IS the ledger's source of truth.
  //    No separate "ledger" table is ever written to; every report
  //    reads from these rows directly.
  let lineNo = 1;
  for (const line of resolvedLines) {
    await client.query(
      `insert into journal_entry_lines
         (journal_entry_id, account_id, debit, credit, narration, party_type, party_id, line_no)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        journalEntryId,
        line.accountId,
        line.debit,
        line.credit,
        line.narration ?? input.narration,
        line.partyType ?? null,
        line.partyId ?? null,
        lineNo++,
      ],
    );
  }

  // 7. Audit
  await writeAudit(client, {
    userId: input.userId,
    action: "post",
    module: "journal_entry",
    recordId: journalEntryId,
    newValue: { jeNo, entryDate: input.entryDate, sourceType: input.sourceType, lines: input.lines },
    ipAddress: input.ipAddress,
  });

  // 8. Posted.
  return { id: journalEntryId, jeNo };
}

/**
 * Posts every active account's opening_balance/opening_type as a
 * single journal entry dated the first day of the given financial
 * year. Without this, chart_of_accounts.opening_balance is inert data
 * — set once at account creation and never actually reflected in any
 * report, so the ledger, trial balance, and balance sheet would all
 * silently start from zero rather than from the true opening
 * position. This closes that gap using the same postJournalEntry()
 * path as everything else — opening balances are not a special case
 * at the storage layer, only at the call site.
 *
 * Idempotent per financial year: throws if opening balances have
 * already been posted for this year (source_type = 'opening_balance'
 * is unique per financial_year_id by construction — see the guard
 * query below), so this can't accidentally double-post.
 *
 * Because this reuses postJournalEntry()'s own validateBalance() call,
 * if the entered opening_balance figures don't actually balance
 * (total debit-side opening balances != total credit-side), this
 * throws UnbalancedEntryError exactly as it would for any other
 * entry — the caller must fix the trial balance before it can be
 * posted, which is the correct behavior, not a bug to work around.
 */
export async function postOpeningBalances(
  client: PgClient,
  financialYearId: number,
  userId: number | null,
): Promise<{ id: number; jeNo: string } | { skipped: true; reason: string }> {
  const { rows: fyRows } = await client.query(
    `select id, code, start_date from financial_years where id = $1`,
    [financialYearId],
  );
  if (fyRows.length === 0) throw new Error(`Financial year ${financialYearId} not found.`);
  const fy = fyRows[0];

  const { rows: alreadyPosted } = await client.query(
    `select id from journal_entries where source_type = 'opening_balance' and source_id = $1`,
    [financialYearId],
  );
  if (alreadyPosted.length > 0) {
    throw new Error(`Opening balances have already been posted for financial year ${fy.code}.`);
  }

  const { rows: accounts } = await client.query(
    `select account_code, opening_balance, opening_type
     from chart_of_accounts
     where is_active = true and opening_balance != 0`,
  );

  if (accounts.length === 0) {
    return { skipped: true, reason: "No active account has a nonzero opening balance." };
  }

  const lines: PostingLineInput[] = accounts.map((a) => ({
    accountCode: a.account_code,
    debit: a.opening_type === "debit" ? Number(a.opening_balance) : 0,
    credit: a.opening_type === "credit" ? Number(a.opening_balance) : 0,
    narration: `Opening balance ${fy.code}`,
  }));

  return postJournalEntry(client, {
    entryDate: fy.start_date.toISOString().slice(0, 10),
    narration: `Opening balances for financial year ${fy.code}`,
    sourceType: "opening_balance",
    sourceId: financialYearId,
    lines,
    userId,
  });
}
export class JournalEntryNotFoundError extends Error {
  constructor(id: number) {
    super(`Journal entry ${id} not found.`);
    this.name = "JournalEntryNotFoundError";
  }
}
export class JournalEntryNotPostedError extends Error {
  constructor(id: number, status: string) {
    super(`Only posted entries can be reversed (journal entry ${id} is currently ${status}).`);
    this.name = "JournalEntryNotPostedError";
  }
}
export class JournalEntryAlreadyReversedError extends Error {
  constructor(jeNo: string) {
    super(`Journal entry ${jeNo} has already been reversed.`);
    this.name = "JournalEntryAlreadyReversedError";
  }
}

export async function reverseJournalEntry(
  client: PgClient,
  journalEntryId: number,
  userId: number | null,
  reason: string,
): Promise<{ id: number; jeNo: string }> {
  const { rows: originalRows } = await client.query(
    `select * from journal_entries where id = $1`,
    [journalEntryId],
  );
  if (originalRows.length === 0) throw new JournalEntryNotFoundError(journalEntryId);
  const original = originalRows[0];

  if (original.status !== "posted") {
    throw new JournalEntryNotPostedError(journalEntryId, original.status);
  }
  if (original.reversed_by_je_id) {
    throw new JournalEntryAlreadyReversedError(original.je_no);
  }

  const { rows: lineRows } = await client.query(
    `select jel.*, coa.account_code
     from journal_entry_lines jel
     join chart_of_accounts coa on coa.id = jel.account_id
     where jel.journal_entry_id = $1
     order by line_no`,
    [journalEntryId],
  );

  // Equal and opposite: every debit becomes a credit and vice versa.
  const reversedLines: PostingLineInput[] = lineRows.map((l) => ({
    accountCode: l.account_code,
    debit: Number(l.credit),
    credit: Number(l.debit),
    narration: `Reversal of ${original.je_no}: ${reason}`,
    partyType: l.party_type ?? undefined,
    partyId: l.party_id ?? undefined,
  }));

  const reversal = await postJournalEntry(client, {
    entryDate: new Date().toISOString().slice(0, 10),
    narration: `Reversal of ${original.je_no}: ${reason}`,
    sourceType: "reversal",
    sourceId: original.id,
    lines: reversedLines,
    userId,
    // FIX: the reversal never inherited the original entry's project_id,
    // so anything scoping a report by project (projectManualJournalNet
    // is the reachable case — manual/contra entries have no document
    // table of their own to filter by status, unlike invoices/receipts/
    // etc., so this project_id tag is the *only* way they're scoped at
    // all) would still count the original's P&L impact forever, with
    // nothing to offset it once reversed. Confirmed live: a reversed
    // manual journal entry's income impact was still fully counted in
    // project reporting after reversal.
    projectId: original.project_id ?? null,
  });

  // The original stays 'posted' forever — it is never edited, deleted,
  // or hidden. reversed_by_je_id alone records that it has been
  // corrected (and is what guards against double-reversal above); it
  // must NOT also flip status to 'cancelled', because every report
  // that correctly filters on status = 'posted' would then lose the
  // original entry while still counting its reversal, leaving a
  // permanent phantom balance equal to the negative of whatever was
  // reversed instead of netting to zero. Confirmed live via the
  // regression suite: cancelling an unallocated invoice left partyLedger
  // and profitAndLoss off by exactly the reversed amount.
  await client.query(
    `update journal_entries set reversed_by_je_id = $1 where id = $2`,
    [reversal.id, original.id],
  );
  await client.query(
    `update journal_entries set reverses_je_id = $1 where id = $2`,
    [original.id, reversal.id],
  );

  await writeAudit(client, {
    userId,
    action: "reverse",
    module: "journal_entry",
    recordId: original.id,
    oldValue: { reversedByJeId: null },
    newValue: { reversedByJeId: reversal.id, reason },
  });

  return reversal;
}
