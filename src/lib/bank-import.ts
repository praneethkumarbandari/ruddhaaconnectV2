import ExcelJS from "exceljs";
import { parse as parseCsvSync } from "csv-parse/sync";
import { pool, query } from "../db/pool.ts";
import type { PgClient } from "../db/pool.ts";

/**
 * Bank Import Engine — Accounting V1.1
 *
 * Architectural boundary (enforced by omission, not by convention):
 * this file has no import from posting-engine.ts, journal-entries.ts,
 * sales.ts, purchases.ts, or reports.ts. It knows nothing about
 * journals, ledgers, or reports — only about parsing files into rows,
 * mapping columns, validating, and detecting duplicates against its
 * own queue history. The only place this module's output ever meets
 * the accounting engine is in routes/bank-import.ts, which calls the
 * *existing* createDraftReceipt/createDraftPayment functions exactly
 * as any other caller would.
 */

export class EmptyFileError extends Error {
  constructor() { super("The uploaded file has no data rows."); this.name = "EmptyFileError"; }
}
export class CorruptFileError extends Error {
  constructor(detail: string) { super(`Could not read the uploaded file: ${detail}`); this.name = "CorruptFileError"; }
}
export class MappingIncompleteError extends Error {
  constructor(missing: string[]) {
    super(`Column mapping is incomplete — missing: ${missing.join(", ")}.`);
    this.name = "MappingIncompleteError";
  }
}
export class BatchNotFoundError extends Error {
  constructor(id: number) { super(`Import batch ${id} not found.`); this.name = "BatchNotFoundError"; }
}
export class RowNotFoundError extends Error {
  constructor(id: number) { super(`Import row ${id} not found.`); this.name = "RowNotFoundError"; }
}
export class RowNotReadyError extends Error {
  constructor(id: number, status: string) {
    super(`Row ${id} is '${status}' — a draft can only be created from a row that is 'ready_for_draft'.`);
    this.name = "RowNotReadyError";
  }
}
export class PartyNotMatchedError extends Error {
  constructor(id: number) { super(`Row ${id} has no matched customer/vendor — select one before creating a draft.`); this.name = "PartyNotMatchedError"; }
}

export const REQUIRED_FIELDS = ["transactionDate", "narration", "debit", "credit"] as const;
export const OPTIONAL_FIELDS = ["balance", "referenceNumber"] as const;
export type MappableField = typeof REQUIRED_FIELDS[number] | typeof OPTIONAL_FIELDS[number];

/** Raw parsed file: header row + string rows. Nothing is validated or typed yet. */
export interface ParsedFile {
  headers: string[];
  rows: string[][];
}

/**
 * Parses CSV or XLSX into a plain header+rows shape. This is the only
 * function in the engine that knows file formats exist — everything
 * downstream works on ParsedFile, agnostic to whether it came from a
 * .csv or a .xlsx.
 */
export async function parseFile(buffer: Buffer, originalName: string): Promise<ParsedFile> {
  const isXlsx = /\.xlsx$/i.test(originalName);
  let raw: string[][];
  try {
    if (isXlsx) {
      const workbook = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await workbook.xlsx.load(buffer as any);
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new Error("workbook has no sheets");
      raw = [];
      sheet.eachRow({ includeEmpty: true }, (row) => {
        const values: string[] = [];
        for (let i = 1; i <= row.cellCount; i++) {
          const cell = row.getCell(i);
          const v = cell.value;
          if (v == null) {
            values.push("");
          } else if (v instanceof Date) {
            // Matches the previous xlsx-based behavior of coercing
            // everything to a plain string; downstream date parsing
            // (bank-import's own row validation) expects a string it
            // can parse itself, not a native Date.
            values.push(v.toISOString().slice(0, 10));
          } else if (typeof v === "object" && v !== null && "text" in v) {
            // Rich text cell
            values.push(String((v as { text?: string }).text ?? ""));
          } else if (typeof v === "object" && v !== null && "result" in v) {
            // Formula cell — use its computed result, same as a plain value would read
            values.push(String((v as { result?: unknown }).result ?? ""));
          } else {
            values.push(String(v));
          }
        }
        raw.push(values);
      });
    } else {
      raw = parseCsvSync(buffer, { skip_empty_lines: false, relax_column_count: true }) as string[][];
    }
  } catch (err) {
    throw new CorruptFileError(err instanceof Error ? err.message : String(err));
  }

  // Drop fully-empty rows (common at the end of exported bank statements)
  // before deciding whether there's any real data — this is file-shape
  // cleanup, not accounting validation.
  const nonEmpty = raw.filter((r) => Array.isArray(r) && r.some((cell) => String(cell ?? "").trim() !== ""));
  if (nonEmpty.length === 0) throw new EmptyFileError();
  if (nonEmpty.length < 2) throw new EmptyFileError(); // header only, no data rows

  const [headers, ...rows] = nonEmpty;
  return { headers: headers.map((h) => String(h ?? "").trim()), rows: rows.map((r) => r.map((c) => String(c ?? "").trim())) };
}

/**
 * Best-effort automatic column matching by fuzzy header-name matching.
 * Returns a partial mapping — callers must check for missing required
 * fields and prompt the user rather than guessing further. This is
 * deliberately dumb pattern matching, not AI categorisation (out of
 * scope) — it only ever matches column *headers* to field names, never
 * inspects row content or infers meaning.
 */
export function autoDetectMapping(headers: string[]): Partial<Record<MappableField, string>> {
  const patterns: Record<MappableField, RegExp> = {
    transactionDate: /\b(txn|transaction|value|posting)?\s*date\b/i,
    narration: /\b(narration|particulars|description|details)\b/i,
    debit: /\b(debit|withdrawal|dr)\b/i,
    credit: /\b(credit|deposit|cr)\b/i,
    balance: /\bbalance\b/i,
    referenceNumber: /\b(reference|ref|cheque|chq|utr|transaction id|txn id)\b/i,
  };
  const mapping: Partial<Record<MappableField, string>> = {};
  for (const header of headers) {
    for (const [field, pattern] of Object.entries(patterns) as [MappableField, RegExp][]) {
      if (mapping[field]) continue; // first match wins, don't overwrite
      if (pattern.test(header)) mapping[field] = header;
    }
  }
  return mapping;
}

export function missingRequiredFields(mapping: Partial<Record<MappableField, string>>): string[] {
  return REQUIRED_FIELDS.filter((f) => !mapping[f]);
}

/** A single row after applying the column mapping, before validation. */
export interface MappedRow {
  rowNumber: number;
  transactionDateRaw: string;
  narration: string;
  debitRaw: string;
  creditRaw: string;
  balanceRaw: string;
  referenceNumber: string;
}

export function applyMapping(parsed: ParsedFile, mapping: Partial<Record<MappableField, string>>): MappedRow[] {
  const missing = missingRequiredFields(mapping);
  if (missing.length > 0) throw new MappingIncompleteError(missing);

  const idx: Partial<Record<MappableField, number>> = {};
  for (const field of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const header = mapping[field];
    if (header) idx[field] = parsed.headers.indexOf(header);
  }

  return parsed.rows.map((row, i) => ({
    rowNumber: i + 1,
    transactionDateRaw: idx.transactionDate != null ? row[idx.transactionDate] ?? "" : "",
    narration: idx.narration != null ? row[idx.narration] ?? "" : "",
    debitRaw: idx.debit != null ? row[idx.debit] ?? "" : "",
    creditRaw: idx.credit != null ? row[idx.credit] ?? "" : "",
    balanceRaw: idx.balance != null ? row[idx.balance] ?? "" : "",
    referenceNumber: idx.referenceNumber != null ? row[idx.referenceNumber] ?? "" : "",
  }));
}

/** Result of validating one row — never throws; every row gets a verdict so one bad row can't stop the batch. */
export interface ValidatedRow {
  rowNumber: number;
  transactionDate: string | null; // ISO date, or null if invalid
  narration: string;
  debit: number;
  credit: number;
  balance: number | null;
  referenceNumber: string | null;
  valid: boolean;
  rejectionReason: string | null;
}

function parseAmount(raw: string): number | null {
  if (raw == null || raw.trim() === "") return 0;
  // Bank exports commonly wrap amounts in parens for negatives, or
  // include thousands separators — strip formatting, not meaning.
  const cleaned = raw.replace(/[,₹\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (cleaned === "" || cleaned === "-") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDate(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  // Accept ISO (yyyy-mm-dd) and common Indian bank export formats
  // (dd/mm/yyyy, dd-mm-yyyy) — deliberately not a generic free-text
  // date parser, since silently misreading e.g. mm/dd vs dd/mm would
  // be a real accounting error, not a parsing nicety.
  let m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = trimmed.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    if (Number(month) > 12) return null; // not actually dd/mm
    return `${m[3]}-${month}-${day}`;
  }
  return null;
}

export function validateRow(row: MappedRow): ValidatedRow {
  const transactionDate = parseDate(row.transactionDateRaw);
  const debit = parseAmount(row.debitRaw);
  const credit = parseAmount(row.creditRaw);
  const balance = row.balanceRaw ? parseAmount(row.balanceRaw) : null;
  const narration = row.narration.trim();
  const referenceNumber = row.referenceNumber.trim() || null;

  const base = {
    rowNumber: row.rowNumber,
    transactionDate,
    narration,
    debit: debit ?? 0,
    credit: credit ?? 0,
    balance,
    referenceNumber,
  };

  if (!transactionDate) return { ...base, valid: false, rejectionReason: `Invalid or missing transaction date: "${row.transactionDateRaw}"` };
  if (!narration) return { ...base, valid: false, rejectionReason: "Missing narration." };
  if (debit === null) return { ...base, valid: false, rejectionReason: `Invalid debit amount: "${row.debitRaw}"` };
  if (credit === null) return { ...base, valid: false, rejectionReason: `Invalid credit amount: "${row.creditRaw}"` };
  if (debit > 0 && credit > 0) return { ...base, valid: false, rejectionReason: "Row has both a debit and a credit amount — exactly one is expected per transaction." };
  if (debit === 0 && credit === 0) return { ...base, valid: false, rejectionReason: "Row has neither a debit nor a credit amount." };

  return { ...base, valid: true, rejectionReason: null };
}

/**
 * Duplicate detection: flags a row as a duplicate if either (a) a
 * previous, non-rejected row already exists in a prior import for the
 * same bank account with the same date + debit + credit + reference
 * number, or (b) an earlier row *within this same file* already has
 * that exact combination (a bank statement export can itself contain
 * a repeated line, and the first occurrence should win). Deliberately
 * looks only at this engine's own queue history — never at
 * journal_entries — since a manually-entered transaction that happens
 * to match isn't a duplicate *import*, and this check has no business
 * reasoning about the ledger at all.
 */
export async function findDuplicateRowNumbers(
  client: PgClient,
  bankAccountCode: string,
  candidates: ValidatedRow[],
): Promise<Set<number>> {
  const dateSet = candidates.filter((r) => r.valid).map((r) => r.transactionDate);
  const dupeRowNumbers = new Set<number>();

  let existingKeys = new Set<string>();
  if (dateSet.length > 0) {
    const { rows: existing } = await client.query(
      `select transaction_date, debit, credit, reference_number
       from bank_import_rows
       where bank_account_code = $1
         and status != 'rejected'
         and transaction_date = any($2::date[])`,
      [bankAccountCode, dateSet],
    );
    existingKeys = new Set(
      existing.map((r: any) => `${r.transaction_date.toISOString().slice(0, 10)}|${Number(r.debit)}|${Number(r.credit)}|${r.reference_number ?? ""}`),
    );
  }

  // Within-file check: track keys seen so far as we walk the candidates
  // in row order, so the *first* occurrence of a repeated line is kept
  // and later ones are flagged — not both, and not neither.
  const seenInThisFile = new Set<string>();
  for (const row of candidates) {
    if (!row.valid) continue;
    const key = `${row.transactionDate}|${row.debit}|${row.credit}|${row.referenceNumber ?? ""}`;
    if (existingKeys.has(key) || seenInThisFile.has(key)) {
      dupeRowNumbers.add(row.rowNumber);
    } else {
      seenInThisFile.add(key);
    }
  }
  return dupeRowNumbers;
}

// ------------------------------------------------------------------
// Batch / queue persistence
// ------------------------------------------------------------------

export type CommitImportInput = {
  fileName: string;
  bankAccountCode: string;
  mappingTemplateId: number | null;
  buffer: Buffer;
  mapping: Partial<Record<MappableField, string>>;
  userId: number | null;
};

/**
 * Parses, validates, and de-duplicates the whole file, then writes one
 * batch row + one row per data row to the queue. Nothing here is an
 * accounting transaction yet — every row lands as 'validated',
 * 'duplicate', or 'rejected'. No journal entry, no receipt, no payment
 * is created by this function.
 */
export async function commitImport(client: PgClient, input: CommitImportInput) {
  const parsed = await parseFile(input.buffer, input.fileName);
  const mapped = applyMapping(parsed, input.mapping);
  const validated = mapped.map(validateRow);
  const dupeRowNumbers = await findDuplicateRowNumbers(client, input.bankAccountCode, validated);

  const { rows: batchRows } = await client.query(
    `insert into bank_import_batches (file_name, bank_account_code, mapping_template_id, status, total_rows, imported_by)
     values ($1, $2, $3, 'processing', $4, $5)
     returning *`,
    [input.fileName, input.bankAccountCode, input.mappingTemplateId, validated.length, input.userId],
  );
  const batch = batchRows[0];

  let rowsImported = 0, rowsRejected = 0, rowsDuplicate = 0;
  for (const row of validated) {
    const isDupe = dupeRowNumbers.has(row.rowNumber);
    const status = !row.valid ? "rejected" : isDupe ? "duplicate" : "validated";
    if (status === "rejected") rowsRejected++;
    else if (status === "duplicate") rowsDuplicate++;
    else rowsImported++;

    await client.query(
      `insert into bank_import_rows
         (batch_id, bank_account_code, row_number, transaction_date, narration, debit, credit, balance, reference_number, status, rejection_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        batch.id, input.bankAccountCode, row.rowNumber, row.transactionDate, row.narration,
        row.debit, row.credit, row.balance, row.referenceNumber, status,
        isDupe ? "Matches an already-imported transaction (same date, amount, and reference)." : row.rejectionReason,
      ],
    );
  }

  // Rows that passed validation and aren't duplicates are immediately
  // promotable to 'ready_for_draft' — there's no further automated step
  // between "valid, unique row" and "a human can now create a draft
  // from it". This is still not accounting: nothing is posted, and no
  // receipt/payment row exists yet.
  await client.query(
    `update bank_import_rows set status = 'ready_for_draft' where batch_id = $1 and status = 'validated'`,
    [batch.id],
  );

  const { rows: updatedBatchRows } = await client.query(
    `update bank_import_batches
     set status = 'completed', rows_imported = $2, rows_rejected = $3, rows_duplicate = $4
     where id = $1
     returning *`,
    [batch.id, rowsImported, rowsRejected, rowsDuplicate],
  );
  return updatedBatchRows[0];
}

export async function listBatches() {
  const { rows } = await query(`select * from bank_import_batches order by imported_at desc, id desc`);
  return rows;
}

export async function getBatch(batchId: number) {
  const { rows } = await query(`select * from bank_import_batches where id = $1`, [batchId]);
  if (rows.length === 0) throw new BatchNotFoundError(batchId);
  return rows[0];
}

export async function getBatchRows(batchId: number) {
  await getBatch(batchId);
  const { rows } = await query(
    `select * from bank_import_rows where batch_id = $1 order by row_number asc`,
    [batchId],
  );
  return rows;
}

export async function matchRowParty(
  client: PgClient,
  rowId: number,
  partyType: "customer" | "vendor",
  partyId: number,
) {
  const { rows } = await client.query(
    `update bank_import_rows set matched_party_type = $2, matched_party_id = $3
     where id = $1 and status = 'ready_for_draft'
     returning *`,
    [rowId, partyType, partyId],
  );
  if (rows.length === 0) {
    const { rows: existing } = await client.query(`select * from bank_import_rows where id = $1`, [rowId]);
    if (existing.length === 0) throw new RowNotFoundError(rowId);
    throw new RowNotReadyError(rowId, existing[0].status);
  }
  return rows[0];
}

// ------------------------------------------------------------------
// Mapping templates
// ------------------------------------------------------------------

export async function saveMappingTemplate(
  templateName: string,
  bankAccountCode: string,
  columnMapping: Partial<Record<MappableField, string>>,
  userId: number | null,
) {
  const { rows } = await query(
    `insert into mapping_templates (template_name, bank_account_code, column_mapping, created_by)
     values ($1, $2, $3, $4)
     returning *`,
    [templateName, bankAccountCode, JSON.stringify(columnMapping), userId],
  );
  return rows[0];
}

export async function listMappingTemplates() {
  const { rows } = await query(`select * from mapping_templates order by template_name asc`);
  return rows;
}

// ------------------------------------------------------------------
// The integration point: this is the ONLY place bank-import.ts talks
// to the accounting engine, and it does so by calling the existing,
// unmodified functions from receipts.ts / payments.ts — the exact
// same functions a manually-entered receipt or payment goes through.
// No journal_entries row is ever touched here directly.
// ------------------------------------------------------------------

export type CreateDraftFromRowDeps = {
  createDraftReceipt: (client: PgClient, input: import("./receipts.ts").CreateDraftReceiptInput) => Promise<any>;
  createDraftPayment: (client: PgClient, input: import("./payments.ts").CreateDraftPaymentInput) => Promise<any>;
};

/**
 * A credit-side row (money coming in) becomes a draft Receipt against
 * the matched customer; a debit-side row (money going out) becomes a
 * draft Payment against the matched vendor. allocations defaults to
 * empty — an unallocated advance — since matching a bank line to a
 * specific invoice is a manual reconciliation step, not something
 * this engine infers (no automatic reconciliation, per scope).
 */
export async function createDraftFromRow(
  client: PgClient,
  rowId: number,
  deps: CreateDraftFromRowDeps,
  userId: number | null,
  allocations: { salesInvoiceId?: number; purchaseInvoiceId?: number; allocatedAmount: number }[] = [],
) {
  const { rows } = await client.query(`select * from bank_import_rows where id = $1`, [rowId]);
  if (rows.length === 0) throw new RowNotFoundError(rowId);
  const row = rows[0];
  if (row.status !== "ready_for_draft") throw new RowNotReadyError(rowId, row.status);
  if (!row.matched_party_type || !row.matched_party_id) throw new PartyNotMatchedError(rowId);

  const entryDate = row.transaction_date.toISOString().slice(0, 10);
  const narration = `Bank import: ${row.narration}`;

  if (Number(row.credit) > 0) {
    if (row.matched_party_type !== "customer") {
      throw new Error(`Row ${rowId} is a credit (money in) but was matched to a vendor, not a customer.`);
    }
    const receipt = await deps.createDraftReceipt(client, {
      customerId: row.matched_party_id,
      receiptDate: entryDate,
      amount: Number(row.credit),
      bankAccountCode: row.bank_account_code,
      allocations: allocations.map((a) => ({ salesInvoiceId: a.salesInvoiceId!, allocatedAmount: a.allocatedAmount })),
      narration,
      userId,
    });
    await client.query(
      `update bank_import_rows set status = 'draft_created', draft_receipt_id = $2 where id = $1`,
      [rowId, receipt.id],
    );
    return { type: "receipt", record: receipt };
  } else {
    if (row.matched_party_type !== "vendor") {
      throw new Error(`Row ${rowId} is a debit (money out) but was matched to a customer, not a vendor.`);
    }
    const payment = await deps.createDraftPayment(client, {
      vendorId: row.matched_party_id,
      paymentDate: entryDate,
      amount: Number(row.debit),
      bankAccountCode: row.bank_account_code,
      allocations: allocations.map((a) => ({ purchaseInvoiceId: a.purchaseInvoiceId!, allocatedAmount: a.allocatedAmount })),
      narration,
      userId,
    });
    await client.query(
      `update bank_import_rows set status = 'draft_created', draft_payment_id = $2 where id = $1`,
      [rowId, payment.id],
    );
    return { type: "payment", record: payment };
  }
}

/**
 * Called after the row's linked draft has been posted through the
 * EXISTING /api/receipts/:id/post or /api/payments/:id/post endpoint
 * (see routes/bank-import.ts) — this only updates the queue's own
 * tracking status to 'posted'. It never itself posts anything; by the
 * time this runs, postReceipt()/postPayment() (unmodified) has already
 * done the real accounting work.
 */
export async function markRowPosted(client: PgClient, rowId: number) {
  const { rows } = await client.query(
    `update bank_import_rows set status = 'posted' where id = $1 and status = 'draft_created' returning *`,
    [rowId],
  );
  if (rows.length === 0) {
    const { rows: existing } = await client.query(`select * from bank_import_rows where id = $1`, [rowId]);
    if (existing.length === 0) throw new RowNotFoundError(rowId);
    throw new RowNotReadyError(rowId, existing[0].status);
  }
  return rows[0];
}

