/**
 * BANK IMPORT ENGINE — REGRESSION SUITE (Accounting V1.1)
 * ========================================================
 *
 * Run with:
 *   npx tsx test/bankimport-regression.ts
 *
 * Requires DATABASE_URL to point at a real Postgres instance that has
 * already had schema.sql + schema-phase2.sql + schema-bankimport.sql
 * applied.
 *
 * This suite drives the actual lib/bank-import.ts functions directly
 * against a real database — not a mock. Critically, several checks
 * here exist specifically to prove the architectural claim of this
 * feature: that an imported transaction ends up as a real journal
 * entry created by the EXISTING, unmodified postReceipt/postPayment
 * functions — by directly inspecting journal_entries.source_type and
 * comparing the resulting ledger state to what a manually-entered
 * receipt/payment produces.
 */

import { pool, withTransaction } from "../src/db/pool.ts";
import {
  parseFile,
  autoDetectMapping,
  missingRequiredFields,
  applyMapping,
  validateRow,
  commitImport,
  getBatchRows,
  matchRowParty,
  createDraftFromRow,
  markRowPosted,
  saveMappingTemplate,
  listMappingTemplates,
  MappingIncompleteError,
  EmptyFileError,
  RowNotReadyError,
  PartyNotMatchedError,
} from "../src/lib/bank-import.ts";
import { createDraftReceipt, postReceipt } from "../src/lib/receipts.ts";
import { createDraftPayment, postPayment } from "../src/lib/payments.ts";
import { trialBalance, customerOutstanding } from "../src/lib/reports.ts";

// ------------------------------------------------------------------
// Tiny test harness (identical pattern to phase2-regression.ts)
// ------------------------------------------------------------------
type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail: msg });
    console.log(`FAIL  ${name}`);
    console.log(`      -> ${msg}`);
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertClose(actual: number, expected: number, msg: string, eps = 0.01) {
  if (Math.abs(actual - expected) > eps) throw new Error(`${msg} (expected ${expected}, got ${actual})`);
}
async function assertThrowsInstance(fn: () => Promise<unknown>, ErrClass: new (...a: any[]) => Error, msg: string) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ErrClass) return;
    const gotName = err instanceof Error ? err.constructor.name : String(err);
    throw new Error(`${msg} — expected ${ErrClass.name} but got ${gotName}`);
  }
  throw new Error(`${msg} — expected ${ErrClass.name} but nothing was thrown`);
}

const RUN = Date.now();
const userId: number | null = null;

function csvBuffer(rows: string[][]): Buffer {
  return Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf8");
}

async function main() {
  const custAlpha = (await pool.query(
    `insert into customers (customer_name, supply_type) values ($1,'intrastate') returning *`,
    [`BankImport Alpha ${RUN}`],
  )).rows[0];
  const vendGamma = (await pool.query(
    `insert into vendors (vendor_name, supply_type) values ($1,'intrastate') returning *`,
    [`BankImport Gamma ${RUN}`],
  )).rows[0];

  const HEADERS = ["Txn Date", "Particulars", "Withdrawal Amt", "Deposit Amt", "Closing Balance", "Chq/Ref No"];
  const MAPPING = {
    transactionDate: "Txn Date", narration: "Particulars",
    debit: "Withdrawal Amt", credit: "Deposit Amt",
    balance: "Closing Balance", referenceNumber: "Chq/Ref No",
  };

  // ==================================================================
  // SECTION 1 — FILE PARSING (CSV + Excel)
  // ==================================================================
  await check("bank-import: CSV parsing extracts headers and data rows correctly", async () => {
    const buf = csvBuffer([HEADERS, ["04/07/2026", "Test narration", "", "1000.00", "5000.00", `REF-${RUN}-1`]]);
    const parsed = await parseFile(buf, "statement.csv");
    assert(parsed.headers.length === 6, `expected 6 headers, got ${parsed.headers.length}`);
    assert(parsed.rows.length === 1, `expected 1 data row, got ${parsed.rows.length}`);
    assert(parsed.headers[0] === "Txn Date", "first header should be 'Txn Date'");
  });

  await check("bank-import: Excel (.xlsx) parsing extracts the same shape as CSV", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(HEADERS);
    ws.addRow(["04/07/2026", "Excel test row", "", "2000.00", "7000.00", `REF-${RUN}-2`]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await parseFile(buf, "statement.xlsx");
    assert(parsed.headers.length === 6, `expected 6 headers, got ${parsed.headers.length}`);
    assert(parsed.rows.length === 1, `expected 1 data row, got ${parsed.rows.length}`);
    assert(parsed.rows[0][1] === "Excel test row", "narration cell should round-trip through xlsx parsing");
  });

  await check("bank-import: empty file (header only, no data rows) is rejected", async () => {
    const buf = csvBuffer([HEADERS]);
    await assertThrowsInstance(async () => parseFile(buf, "empty.csv"), EmptyFileError, "header-only file should be rejected as empty");
  });

  await check("bank-import: fully empty file is rejected", async () => {
    const buf = Buffer.from("", "utf8");
    await assertThrowsInstance(async () => parseFile(buf, "blank.csv"), EmptyFileError, "fully empty file should be rejected");
  });

  // ==================================================================
  // SECTION 2 — COLUMN MAPPING
  // ==================================================================
  await check("bank-import: auto-detect mapping identifies all required fields from common header names", async () => {
    const mapping = autoDetectMapping(HEADERS);
    const missing = missingRequiredFields(mapping);
    assert(missing.length === 0, `expected no missing required fields, got: ${missing.join(", ")}`);
    assert(mapping.transactionDate === "Txn Date", "should map transactionDate to 'Txn Date'");
    assert(mapping.debit === "Withdrawal Amt", "should map debit to 'Withdrawal Amt'");
  });

  await check("bank-import: incomplete mapping (missing a required field) is rejected before parsing rows", async () => {
    const parsed = await parseFile(csvBuffer([HEADERS, ["04/07/2026", "x", "", "100", "", ""]]), "s.csv");
    const incompleteMapping = { transactionDate: "Txn Date", narration: "Particulars" }; // missing debit, credit
    await assertThrowsInstance(
      async () => applyMapping(parsed, incompleteMapping),
      MappingIncompleteError,
      "mapping missing debit/credit should be rejected",
    );
  });

  await check("bank-import: mapping template can be saved and listed", async () => {
    const template = await saveMappingTemplate(`Test Template ${RUN}`, "1100", MAPPING, userId);
    assert(template.id != null, "saved template should have an id");
    const templates = await listMappingTemplates();
    assert(templates.some((t: any) => t.id === template.id), "saved template should appear in the list");
  });

  // ==================================================================
  // SECTION 3 — ROW VALIDATION (one bad row must not block the batch)
  // ==================================================================
  await check("bank-import: row validation rejects invalid date, missing narration, invalid amount, and both-debit-and-credit — independently, without stopping other rows", async () => {
    const parsed = await parseFile(
      csvBuffer([
        HEADERS,
        ["04/07/2026", "Valid row", "", "500.00", "1000.00", `REF-${RUN}-V1`],
        ["not-a-date", "Bad date", "", "100.00", "900.00", `REF-${RUN}-V2`],
        ["05/07/2026", "", "50.00", "", "850.00", `REF-${RUN}-V3`],
        ["06/07/2026", "Bad amount", "abc", "", "800.00", `REF-${RUN}-V4`],
        ["07/07/2026", "Both sides", "100.00", "100.00", "700.00", `REF-${RUN}-V5`],
      ]),
      "mixed.csv",
    );
    const mapped = applyMapping(parsed, MAPPING);
    const validated = mapped.map(validateRow);
    assert(validated.length === 5, "all 5 rows should produce a verdict, none should throw and abort the batch");
    assert(validated[0].valid, "row 1 (valid) should pass");
    assert(!validated[1].valid && /date/i.test(validated[1].rejectionReason ?? ""), "row 2 (bad date) should be rejected with a date-related reason");
    assert(!validated[2].valid && /narration/i.test(validated[2].rejectionReason ?? ""), "row 3 (missing narration) should be rejected");
    assert(!validated[3].valid && /debit/i.test(validated[3].rejectionReason ?? ""), "row 4 (bad amount) should be rejected");
    assert(!validated[4].valid && /both/i.test(validated[4].rejectionReason ?? ""), "row 5 (both debit and credit) should be rejected");
  });

  // ==================================================================
  // SECTION 4 — DUPLICATE DETECTION (within-file AND cross-batch)
  // ==================================================================
  const dupeRef = `REF-${RUN}-DUPE`;
  await check("bank-import: duplicate rows within the SAME file are flagged (only the first occurrence is kept)", async () => {
    const buf = csvBuffer([
      HEADERS,
      ["04/07/2026", "Original", "", "1234.00", "9999.00", dupeRef],
      ["04/07/2026", "Repeated line in same file", "", "1234.00", "9999.00", dupeRef],
    ]);
    const batch = await withTransaction((client) =>
      commitImport(client, { fileName: "dupe-within.csv", bankAccountCode: "1100-BI-TEST", mappingTemplateId: null, buffer: buf, mapping: MAPPING, userId }),
    );
    assert(batch.rows_imported === 1, `expected 1 imported (first occurrence), got ${batch.rows_imported}`);
    assert(batch.rows_duplicate === 1, `expected 1 duplicate (second occurrence), got ${batch.rows_duplicate}`);
  });

  await check("bank-import: re-importing the same file a second time flags everything as duplicate (cross-batch)", async () => {
    const buf = csvBuffer([HEADERS, ["04/07/2026", "Original", "", "1234.00", "9999.00", dupeRef]]);
    const batch = await withTransaction((client) =>
      commitImport(client, { fileName: "dupe-within.csv", bankAccountCode: "1100-BI-TEST", mappingTemplateId: null, buffer: buf, mapping: MAPPING, userId }),
    );
    assert(batch.rows_duplicate === 1, `expected the re-imported row to be flagged duplicate against the earlier batch, got rows_duplicate=${batch.rows_duplicate}`);
    assert(batch.rows_imported === 0, `expected 0 newly-imported rows on re-import, got ${batch.rows_imported}`);
  });

  // ==================================================================
  // SECTION 5 — IMPORT QUEUE STATUSES
  // ==================================================================
  let queueBatchId: number;
  let creditRowId: number;
  let debitRowId: number;
  await check("bank-import: a committed batch populates the queue with correct per-row statuses", async () => {
    const buf = csvBuffer([
      HEADERS,
      ["04/07/2026", "Receipt candidate", "", "5000.00", "10000.00", `REF-${RUN}-Q1`],
      ["04/07/2026", "Payment candidate", "2000.00", "", "8000.00", `REF-${RUN}-Q2`],
    ]);
    const batch = await withTransaction((client) =>
      commitImport(client, { fileName: "queue.csv", bankAccountCode: "1100", mappingTemplateId: null, buffer: buf, mapping: MAPPING, userId }),
    );
    queueBatchId = batch.id;
    const rows = await getBatchRows(batch.id);
    assert(rows.length === 2, `expected 2 queue rows, got ${rows.length}`);
    assert(rows.every((r: any) => r.status === "ready_for_draft"), "both valid, non-duplicate rows should be 'ready_for_draft'");
    creditRowId = rows.find((r: any) => Number(r.credit) > 0).id;
    debitRowId = rows.find((r: any) => Number(r.debit) > 0).id;
  });

  await check("bank-import: fetching a nonexistent batch's rows fails clearly", async () => {
    const { BatchNotFoundError } = await import("../src/lib/bank-import.ts");
    await assertThrowsInstance(async () => getBatchRows(999999999), BatchNotFoundError, "nonexistent batch should raise BatchNotFoundError");
  });

  // ==================================================================
  // SECTION 6 — DRAFT CREATION (must call the EXISTING engine, not duplicate it)
  // ==================================================================
  await check("bank-import: creating a draft before a party is matched is rejected", async () => {
    await assertThrowsInstance(
      () => withTransaction((client) => createDraftFromRow(client, creditRowId, { createDraftReceipt, createDraftPayment }, userId)),
      PartyNotMatchedError,
      "draft creation without a matched party should be rejected",
    );
  });

  await check("bank-import: matching a row to a party succeeds and is reflected in the queue", async () => {
    const updated = await withTransaction((client) => matchRowParty(client, creditRowId, "customer", custAlpha.id));
    assert(updated.matched_party_type === "customer" && String(updated.matched_party_id) === String(custAlpha.id), "row should record the matched customer");
    await withTransaction((client) => matchRowParty(client, debitRowId, "vendor", vendGamma.id));
  });

  let creditReceiptId: number;
  let debitPaymentId: number;
  await check("bank-import: create-draft on a credit row calls the EXISTING createDraftReceipt (proof: a real receipts row appears, still in 'draft' status, no journal entry yet)", async () => {
    const beforeJeCount = (await pool.query(`select count(*) from journal_entries`)).rows[0].count;
    const result = await withTransaction((client) => createDraftFromRow(client, creditRowId, { createDraftReceipt, createDraftPayment }, userId));
    assert(result.type === "receipt", "a credit row should produce a receipt draft");
    assert(result.record.status === "draft", "the created receipt should be in draft status, not yet posted");
    creditReceiptId = result.record.id;
    const afterJeCount = (await pool.query(`select count(*) from journal_entries`)).rows[0].count;
    assert(beforeJeCount === afterJeCount, "draft creation must not create any journal entry — that's the posting engine's job, not the import engine's");
  });

  await check("bank-import: create-draft on a debit row calls the EXISTING createDraftPayment (same proof, payment side)", async () => {
    const result = await withTransaction((client) => createDraftFromRow(client, debitRowId, { createDraftReceipt, createDraftPayment }, userId));
    assert(result.type === "payment", "a debit row should produce a payment draft");
    assert(result.record.status === "draft", "the created payment should be in draft status");
    debitPaymentId = result.record.id;
  });

  await check("bank-import: attempting to create a draft twice from the same row is rejected (row is no longer 'ready_for_draft')", async () => {
    await assertThrowsInstance(
      () => withTransaction((client) => createDraftFromRow(client, creditRowId, { createDraftReceipt, createDraftPayment }, userId)),
      RowNotReadyError,
      "a second draft-creation attempt on an already-processed row should be rejected",
    );
  });

  // ==================================================================
  // SECTION 7 — POSTING THROUGH THE EXISTING ENGINE (the core architectural proof)
  // ==================================================================
  await check("bank-import: posting the row's draft goes through the EXISTING postReceipt (proof: journal_entries.source_type = 'receipt', not a bank-import-specific type)", async () => {
    await withTransaction((client) => postReceipt(client, creditReceiptId, userId));
    await withTransaction((client) => markRowPosted(client, creditRowId));

    const { rows } = await pool.query(
      `select je.source_type, r.narration as receipt_narration from receipts r join journal_entries je on je.id = r.journal_entry_id where r.id = $1`,
      [creditReceiptId],
    );
    assert(rows.length === 1, "the posted receipt should have a linked journal entry");
    assert(rows[0].source_type === "receipt", `expected source_type 'receipt' (the standard receipt posting path, unmodified), got '${rows[0].source_type}'`);
    // NOTE: the journal entry's own narration is built by the existing,
    // frozen posting engine as "Receipt {no} — {customer}" — that's
    // correct, unmodified behavior and must not change. Traceability to
    // the import lives on the receipt record itself, which does carry
    // the "Bank import: ..." prefix through unchanged.
    assert(rows[0].receipt_narration.startsWith("Bank import:"), "the receipt's own narration should trace back to the import for auditability");
  });

  await check("bank-import: posting the payment side goes through the EXISTING postPayment identically", async () => {
    await withTransaction((client) => postPayment(client, debitPaymentId, userId));
    await withTransaction((client) => markRowPosted(client, debitRowId));

    const { rows } = await pool.query(
      `select je.source_type from payments p join journal_entries je on je.id = p.journal_entry_id where p.id = $1`,
      [debitPaymentId],
    );
    assert(rows.length === 1 && rows[0].source_type === "payment", `expected source_type 'payment', got '${rows[0]?.source_type}'`);
  });

  await check("bank-import: after posting, the queue row status is 'posted' and the batch/report figures reflect it exactly like a manual entry would", async () => {
    const rows = await getBatchRows(queueBatchId);
    const creditRow = rows.find((r: any) => r.id === creditRowId);
    const debitRow = rows.find((r: any) => r.id === debitRowId);
    assert(creditRow.status === "posted", `expected credit row status 'posted', got '${creditRow.status}'`);
    assert(debitRow.status === "posted", `expected debit row status 'posted', got '${debitRow.status}'`);

    const outstanding = await customerOutstanding();
    const alphaRow = outstanding.find((r: any) => r.customer_id === custAlpha.id);
    // The imported receipt was unallocated (no invoice), so it posts as
    // an unallocated advance — a *negative* outstanding (we owe them),
    // exactly as a manually-entered unallocated receipt would.
    assertClose(alphaRow ? Number(alphaRow.outstanding) : 0, -5000, "customer outstanding should reflect the imported receipt exactly as a manual one would");
  });

  await check("bank-import: attempting to post a row that has no draft yet is rejected", async () => {
    const buf = csvBuffer([HEADERS, ["04/07/2026", "No draft yet", "", "300.00", "1000.00", `REF-${RUN}-ND`]]);
    const batch = await withTransaction((client) =>
      commitImport(client, { fileName: "nodraft.csv", bankAccountCode: "1100", mappingTemplateId: null, buffer: buf, mapping: MAPPING, userId }),
    );
    const rows = await getBatchRows(batch.id);
    await assertThrowsInstance(
      () => withTransaction((client) => markRowPosted(client, rows[0].id)),
      RowNotReadyError,
      "marking a row posted before a draft exists should be rejected",
    );
  });

  // ==================================================================
  // SECTION 8 — TRIAL BALANCE SANITY CHECK
  // ==================================================================
  await check("bank-import: trial balance still balances after all imported-and-posted transactions", async () => {
    const tb = await trialBalance(new Date().toISOString().slice(0, 10));
    assert(tb.balanced, `trial balance should balance after bank-import postings: debit ${tb.debitTotal} vs credit ${tb.creditTotal}`);
  });

  // ==================================================================
  // SUMMARY
  // ==================================================================
  const failed = results.filter((r) => !r.pass);
  console.log("\n" + "=".repeat(60));
  console.log(`Total: ${results.length}   Passed: ${results.length - failed.length}   Failed: ${failed.length}`);
  console.log("=".repeat(60));
  await pool.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
