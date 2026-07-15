/**
 * PHASE 2 — COMPREHENSIVE AUTOMATED REGRESSION SUITE
 * ====================================================
 *
 * Run with:
 *   npx tsx test/phase2-regression.ts
 *
 * Requires DATABASE_URL to point at a real Postgres instance that has
 * already had schema.sql + schema-phase2.sql applied (see README).
 *
 * This suite drives the actual lib/*.ts functions directly (the same
 * code every HTTP route calls) against a real database — it is not a
 * mock, not a dry run, and does not assert anything from reading the
 * source. Every assertion is checked against live query results.
 *
 * Exits 0 if every test passes, exits 1 (non-zero) if anything fails,
 * printing PASS/FAIL for every individual test plus a final summary.
 *
 * Test data uses a per-run timestamp suffix in customer/vendor names,
 * so this suite is safe to re-run against a database that already
 * has data in it (old test runs don't collide with new ones, and
 * reconciliation checks are scoped to this run's own customer/vendor
 * ids rather than the whole database).
 */

import { pool, withTransaction } from "../src/db/pool.ts";
import { createDraftSalesInvoice, postSalesInvoice, cancelSalesInvoice, InvoiceHasAllocationsError } from "../src/lib/sales.ts";
import { createDraftPurchaseInvoice, postPurchaseInvoice, cancelPurchaseInvoice, PurchaseHasAllocationsError } from "../src/lib/purchases.ts";
import {
  createDraftReceipt,
  postReceipt,
  cancelReceipt,
  ReceiptHasAllocationsError,
  OverAllocationError as ReceiptOverAllocationError,
  AllocationExceedsOutstandingError as ReceiptAllocationExceedsOutstandingError,
} from "../src/lib/receipts.ts";
import {
  createDraftPayment,
  postPayment,
  cancelPayment,
  PaymentHasAllocationsError,
  OverAllocationError as PaymentOverAllocationError,
  AllocationExceedsOutstandingError as PaymentAllocationExceedsOutstandingError,
} from "../src/lib/payments.ts";
import { createDraftCreditNote, postCreditNote, createDraftDebitNote, postDebitNote } from "../src/lib/notes.ts";
import { postContra } from "../src/lib/contra.ts";
import { trialBalance, profitAndLoss, balanceSheet, customerOutstanding, vendorOutstanding, partyLedger, gstReport, dayBook } from "../src/lib/reports.ts";

// ------------------------------------------------------------------
// Tiny test harness
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
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`${msg} (expected ${expected}, got ${actual})`);
  }
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
const todayISO = () => new Date().toISOString().slice(0, 10);
const userId: number | null = null;

async function main() {
  // ==================================================================
  // SECTION 0 — SEED MASTER DATA
  // ==================================================================
  const custAlpha = (await pool.query(
    `insert into customers (customer_name, supply_type) values ($1,'intrastate') returning *`,
    [`TestCo Alpha ${RUN}`],
  )).rows[0];
  const custBeta = (await pool.query(
    `insert into customers (customer_name, supply_type) values ($1,'interstate') returning *`,
    [`TestCo Beta ${RUN}`],
  )).rows[0];
  const vendAlpha = (await pool.query(
    `insert into vendors (vendor_name, supply_type) values ($1,'intrastate') returning *`,
    [`VendorCo Alpha ${RUN}`],
  )).rows[0];
  const vendBeta = (await pool.query(
    `insert into vendors (vendor_name, supply_type) values ($1,'interstate') returning *`,
    [`VendorCo Beta ${RUN}`],
  )).rows[0];

  await check("seed: customers and vendors created", async () => {
    assert(!!custAlpha?.id && !!custBeta?.id && !!vendAlpha?.id && !!vendBeta?.id, "one or more master records failed to insert");
  });

  // ==================================================================
  // SECTION 1 — SALES INVOICES (multiple + mixed GST)
  // ==================================================================
  async function makeSalesInvoice(customerId: number, subtotal: number, gstRate: number) {
    const draft = await withTransaction((c) =>
      createDraftSalesInvoice(c, {
        customerId,
        invoiceDate: todayISO(),
        lines: [{ description: "Test line", qty: 1, rate: subtotal, gstRate }],
        userId,
      }),
    );
    return withTransaction((c) => postSalesInvoice(c, draft.id, userId));
  }

  let invA: any, invB: any, invC: any, invD: any, invE: any;

  await check("sales: post invoice A (Alpha, intrastate, 1000+18%)", async () => {
    invA = await makeSalesInvoice(custAlpha.id, 1000, 18);
    assertClose(Number(invA.total), 1180, "invoice A total wrong");
  });
  await check("sales: post invoice B (Alpha, intrastate, 2000+18%)", async () => {
    invB = await makeSalesInvoice(custAlpha.id, 2000, 18);
    assertClose(Number(invB.total), 2360, "invoice B total wrong");
  });
  await check("sales: post invoice C (Alpha, intrastate, 3000+18%)", async () => {
    invC = await makeSalesInvoice(custAlpha.id, 3000, 18);
    assertClose(Number(invC.total), 3540, "invoice C total wrong");
  });
  await check("sales: post invoice D (Beta, interstate, 5000+18%)", async () => {
    invD = await makeSalesInvoice(custBeta.id, 5000, 18);
    assertClose(Number(invD.total), 5900, "invoice D total wrong");
  });

  await check("sales: Alpha outstanding = 7080 after A+B+C", async () => {
    const row = (await customerOutstanding()).find((r: any) => r.customer_id === custAlpha.id);
    assert(!!row, "Alpha missing from customerOutstanding");
    assertClose(Number(row.outstanding), 7080, "Alpha outstanding wrong");
  });
  await check("sales: Beta outstanding = 5900 after D", async () => {
    const row = (await customerOutstanding()).find((r: any) => r.customer_id === custBeta.id);
    assert(!!row, "Beta missing from customerOutstanding");
    assertClose(Number(row.outstanding), 5900, "Beta outstanding wrong");
  });

  // ==================================================================
  // SECTION 2 — PURCHASE INVOICES (multiple + mixed GST)
  // ==================================================================
  async function makePurchaseInvoice(vendorId: number, subtotal: number, gstRate: number) {
    const draft = await withTransaction((c) =>
      createDraftPurchaseInvoice(c, {
        vendorId,
        invoiceDate: todayISO(),
        lines: [{ description: "Test line", qty: 1, rate: subtotal, gstRate }],
        userId,
      }),
    );
    return withTransaction((c) => postPurchaseInvoice(c, draft.id, userId));
  }

  let purA: any, purB: any, purC: any, purD: any;

  await check("purchase: post invoice A (Alpha, intrastate, 800+18%)", async () => {
    purA = await makePurchaseInvoice(vendAlpha.id, 800, 18);
    assertClose(Number(purA.total), 944, "purchase A total wrong");
  });
  await check("purchase: post invoice B (Alpha, intrastate, 1200+18%)", async () => {
    purB = await makePurchaseInvoice(vendAlpha.id, 1200, 18);
    assertClose(Number(purB.total), 1416, "purchase B total wrong");
  });
  await check("purchase: post invoice C (Alpha, intrastate, 1500+18%)", async () => {
    purC = await makePurchaseInvoice(vendAlpha.id, 1500, 18);
    assertClose(Number(purC.total), 1770, "purchase C total wrong");
  });
  await check("purchase: post invoice D (Beta, interstate, 2000+18%)", async () => {
    purD = await makePurchaseInvoice(vendBeta.id, 2000, 18);
    assertClose(Number(purD.total), 2360, "purchase D total wrong");
  });

  await check("purchase: Vendor Alpha outstanding = 4130 after A+B+C", async () => {
    const row = (await vendorOutstanding()).find((r: any) => r.vendor_id === vendAlpha.id);
    assert(!!row, "Vendor Alpha missing from vendorOutstanding");
    assertClose(Number(row.outstanding), 4130, "Vendor Alpha outstanding wrong");
  });
  await check("purchase: Vendor Beta outstanding = 2360 after D", async () => {
    const row = (await vendorOutstanding()).find((r: any) => r.vendor_id === vendBeta.id);
    assert(!!row, "Vendor Beta missing from vendorOutstanding");
    assertClose(Number(row.outstanding), 2360, "Vendor Beta outstanding wrong");
  });

  // ==================================================================
  // SECTION 3 — RECEIPTS: partial + multi-invoice allocation
  // ==================================================================
  let receipt1: any, receipt2: any;

  await check("receipt: post receipt1 — 3000, partial+multi (1180 to A full, 1820 to B partial)", async () => {
    const draft = await withTransaction((c) =>
      createDraftReceipt(c, {
        customerId: custAlpha.id,
        receiptDate: todayISO(),
        amount: 3000,
        bankAccountCode: "1100",
        allocations: [
          { salesInvoiceId: invA.id, allocatedAmount: 1180 },
          { salesInvoiceId: invB.id, allocatedAmount: 1820 },
        ],
        userId,
      }),
    );
    receipt1 = await withTransaction((c) => postReceipt(c, draft.id, userId));
    assertClose(Number(receipt1.amount), 3000, "receipt1 amount wrong");
  });

  await check("receipt: post receipt2 — 4080, closes B [540 remaining] + full C [3540]", async () => {
    const draft = await withTransaction((c) =>
      createDraftReceipt(c, {
        customerId: custAlpha.id,
        receiptDate: todayISO(),
        amount: 4080,
        bankAccountCode: "1100",
        allocations: [
          { salesInvoiceId: invB.id, allocatedAmount: 540 },
          { salesInvoiceId: invC.id, allocatedAmount: 3540 },
        ],
        userId,
      }),
    );
    receipt2 = await withTransaction((c) => postReceipt(c, draft.id, userId));
    assertClose(Number(receipt2.amount), 4080, "receipt2 amount wrong");
  });

  await check("receipt: over-allocation is rejected before it reaches the posting engine", async () => {
    await assertThrowsInstance(
      () =>
        withTransaction((c) =>
          createDraftReceipt(c, {
            customerId: custAlpha.id,
            receiptDate: todayISO(),
            amount: 100,
            bankAccountCode: "1100",
            allocations: [{ salesInvoiceId: invA.id, allocatedAmount: 200 }],
            userId,
          }),
        ),
      ReceiptOverAllocationError,
      "over-allocated receipt should be rejected",
    );
  });

  await check("receipt: Alpha outstanding = 0 after receipt1+receipt2 (7080 fully received)", async () => {
    const row = (await customerOutstanding()).find((r: any) => r.customer_id === custAlpha.id);
    assert(!row, `Alpha should have zero outstanding but found ${row ? row.outstanding : "n/a"}`);
  });

  // ==================================================================
  // SECTION 4 — PAYMENTS: partial + multi-bill allocation
  // ==================================================================
  let payment1: any, payment2: any;

  await check("payment: post payment1 — 1500, partial+multi (944 to A full, 556 to B partial)", async () => {
    const draft = await withTransaction((c) =>
      createDraftPayment(c, {
        vendorId: vendAlpha.id,
        paymentDate: todayISO(),
        amount: 1500,
        bankAccountCode: "1100",
        allocations: [
          { purchaseInvoiceId: purA.id, allocatedAmount: 944 },
          { purchaseInvoiceId: purB.id, allocatedAmount: 556 },
        ],
        userId,
      }),
    );
    payment1 = await withTransaction((c) => postPayment(c, draft.id, userId));
    assertClose(Number(payment1.amount), 1500, "payment1 amount wrong");
  });

  await check("payment: post payment2 — 2630, closes B [860 remaining] + full C [1770]", async () => {
    const draft = await withTransaction((c) =>
      createDraftPayment(c, {
        vendorId: vendAlpha.id,
        paymentDate: todayISO(),
        amount: 2630,
        bankAccountCode: "1100",
        allocations: [
          { purchaseInvoiceId: purB.id, allocatedAmount: 860 },
          { purchaseInvoiceId: purC.id, allocatedAmount: 1770 },
        ],
        userId,
      }),
    );
    payment2 = await withTransaction((c) => postPayment(c, draft.id, userId));
    assertClose(Number(payment2.amount), 2630, "payment2 amount wrong");
  });

  await check("payment: over-allocation is rejected before it reaches the posting engine", async () => {
    await assertThrowsInstance(
      () =>
        withTransaction((c) =>
          createDraftPayment(c, {
            vendorId: vendAlpha.id,
            paymentDate: todayISO(),
            amount: 100,
            bankAccountCode: "1100",
            allocations: [{ purchaseInvoiceId: purA.id, allocatedAmount: 200 }],
            userId,
          }),
        ),
      PaymentOverAllocationError,
      "over-allocated payment should be rejected",
    );
  });

  await check("payment: Vendor Alpha outstanding = 0 after payment1+payment2 (4130 fully paid)", async () => {
    const row = (await vendorOutstanding()).find((r: any) => r.vendor_id === vendAlpha.id);
    assert(!row, `Vendor Alpha should have zero outstanding but found ${row ? row.outstanding : "n/a"}`);
  });

  // ==================================================================
  // SECTION 5 — CREDIT NOTE / DEBIT NOTE (mixed GST, interstate)
  // ==================================================================
  let creditNote: any, debitNote: any;

  await check("credit note: post against invoice D (Beta, interstate, 1000+18% IGST)", async () => {
    const draft = await withTransaction((c) =>
      createDraftCreditNote(c, {
        customerId: custBeta.id,
        againstInvoiceId: invD.id,
        noteDate: todayISO(),
        lines: [{ description: "Return", qty: 1, rate: 1000, gstRate: 18 }],
        userId,
      }),
    );
    creditNote = await withTransaction((c) => postCreditNote(c, draft.id, userId));
    assertClose(Number(creditNote.total), 1180, "credit note total wrong");
  });

  await check("credit note: Beta outstanding drops from 5900 to 4720", async () => {
    const row = (await customerOutstanding()).find((r: any) => r.customer_id === custBeta.id);
    assert(!!row, "Beta missing from customerOutstanding after credit note");
    assertClose(Number(row.outstanding), 4720, "Beta outstanding after credit note wrong");
  });

  await check("debit note: post against purchase D (Beta vendor, interstate, 500+18% IGST)", async () => {
    const draft = await withTransaction((c) =>
      createDraftDebitNote(c, {
        vendorId: vendBeta.id,
        againstInvoiceId: purD.id,
        noteDate: todayISO(),
        lines: [{ description: "Return", qty: 1, rate: 500, gstRate: 18 }],
        userId,
      }),
    );
    debitNote = await withTransaction((c) => postDebitNote(c, draft.id, userId));
    assertClose(Number(debitNote.total), 590, "debit note total wrong");
  });

  await check("debit note: Vendor Beta outstanding drops from 2360 to 1770", async () => {
    const row = (await vendorOutstanding()).find((r: any) => r.vendor_id === vendBeta.id);
    assert(!!row, "Vendor Beta missing from vendorOutstanding after debit note");
    assertClose(Number(row.outstanding), 1770, "Vendor Beta outstanding after debit note wrong");
  });

  // ==================================================================
  // SECTION 6 — CONTRA VOUCHER
  // ==================================================================
  await check("contra: move 500 from Bank to Cash posts cleanly", async () => {
    const posted = await withTransaction((c) =>
      postContra(c, { entryDate: todayISO(), fromAccountCode: "1100", toAccountCode: "1000", amount: 500, userId }),
    );
    assert(!!posted.id, "contra did not post");
  });

  // ==================================================================
  // SECTION 7 — INVALID CANCELLATIONS (every one of these MUST be blocked)
  // ==================================================================
  await check("cancel: invoice A is blocked (has a receipt allocation against it)", async () => {
    await assertThrowsInstance(
      () => withTransaction((c) => cancelSalesInvoice(c, invA.id, userId, "test")),
      InvoiceHasAllocationsError,
      "cancelling an allocated invoice should be blocked",
    );
  });
  await check("cancel: purchase A is blocked (has a payment allocation against it)", async () => {
    await assertThrowsInstance(
      () => withTransaction((c) => cancelPurchaseInvoice(c, purA.id, userId, "test")),
      PurchaseHasAllocationsError,
      "cancelling an allocated purchase should be blocked",
    );
  });
  await check("cancel: receipt1 is blocked (has allocations recorded against it)", async () => {
    await assertThrowsInstance(
      () => withTransaction((c) => cancelReceipt(c, receipt1.id, userId, "test")),
      ReceiptHasAllocationsError,
      "cancelling a receipt with allocations should be blocked",
    );
  });
  await check("cancel: payment1 is blocked (has allocations recorded against it)", async () => {
    await assertThrowsInstance(
      () => withTransaction((c) => cancelPayment(c, payment1.id, userId, "test")),
      PaymentHasAllocationsError,
      "cancelling a payment with allocations should be blocked",
    );
  });

  // ==================================================================
  // SECTION 8 — VALID CANCELLATION + NET-ZERO REVERSAL CHECK
  //
  // An invoice with NO allocations must still be cancellable, and once
  // cancelled its net contribution to every report must be exactly
  // zero — not just "removed from outstanding" but the underlying
  // control account and trial balance must be completely unaffected,
  // as if the invoice had never been posted. This is checked directly
  // against live query results before vs. after, not assumed.
  // ==================================================================
  let baselineAlphaOutstanding = 0;
  let baselineDebtorsBalance = 0;

  await check("cancel: capture baseline before posting a throwaway invoice E", async () => {
    const row = (await customerOutstanding()).find((r: any) => r.customer_id === custAlpha.id);
    baselineAlphaOutstanding = row ? Number(row.outstanding) : 0;
    const tb = await trialBalance(todayISO());
    const debtorsRow = tb.rows.find((r: any) => r.account_code === "1200");
    baselineDebtorsBalance = debtorsRow ? Number(debtorsRow.balance) : 0;
  });

  await check("cancel: post throwaway invoice E (Alpha, 100+18%, no allocations)", async () => {
    invE = await makeSalesInvoice(custAlpha.id, 100, 18);
    assertClose(Number(invE.total), 118, "invoice E total wrong");
  });

  await check("cancel: invoice E has no allocations, so cancellation succeeds", async () => {
    const result = await withTransaction((c) => cancelSalesInvoice(c, invE.id, userId, "test cleanup"));
    assert(result.status === "cancelled", "invoice E should be cancelled");
  });

  await check("cancel: Alpha outstanding returns exactly to the pre-invoice-E baseline", async () => {
    const row = (await customerOutstanding()).find((r: any) => r.customer_id === custAlpha.id);
    const after = row ? Number(row.outstanding) : 0;
    assertClose(
      after,
      baselineAlphaOutstanding,
      "Alpha outstanding did not return to baseline after cancelling an unallocated invoice — the reversal is leaving a residual balance behind",
    );
  });

  await check("cancel: Trade Debtors control account (1200) returns exactly to the pre-invoice-E baseline", async () => {
    const tb = await trialBalance(todayISO());
    const debtorsRow = tb.rows.find((r: any) => r.account_code === "1200");
    const after = debtorsRow ? Number(debtorsRow.balance) : 0;
    assertClose(
      after,
      baselineDebtorsBalance,
      "Trade Debtors control account did not return to baseline after cancelling an unallocated invoice — the reversal is leaving a residual balance behind",
    );
  });

  await check("cancel: trial balance still balances after the cancellation", async () => {
    const tb = await trialBalance(todayISO());
    assert(tb.balanced, `Trial balance does not balance: debit ${tb.debitTotal} vs credit ${tb.creditTotal}`);
  });

  // ==================================================================
  // SECTION 9 — OUTSTANDING / LEDGER / CONTROL ACCOUNT RECONCILIATION
  // ==================================================================
  const FAR_PAST = "2000-01-01";
  const FAR_FUTURE = "2100-01-01";

  await check("reconcile: Alpha party ledger closing balance matches customerOutstanding", async () => {
    const ledger = await partyLedger("customer", custAlpha.id, FAR_PAST, FAR_FUTURE);
    const row = (await customerOutstanding()).find((r: any) => r.customer_id === custAlpha.id);
    assertClose(ledger.closingBalance, row ? Number(row.outstanding) : 0, "Alpha ledger closing balance != customerOutstanding");
  });

  await check("reconcile: Beta party ledger closing balance matches customerOutstanding", async () => {
    const ledger = await partyLedger("customer", custBeta.id, FAR_PAST, FAR_FUTURE);
    const row = (await customerOutstanding()).find((r: any) => r.customer_id === custBeta.id);
    assertClose(ledger.closingBalance, row ? Number(row.outstanding) : 0, "Beta ledger closing balance != customerOutstanding");
  });

  await check("reconcile: Vendor Alpha party ledger closing balance matches vendorOutstanding", async () => {
    const ledger = await partyLedger("vendor", vendAlpha.id, FAR_PAST, FAR_FUTURE);
    const row = (await vendorOutstanding()).find((r: any) => r.vendor_id === vendAlpha.id);
    // partyLedger's closingBalance is raw (debit - credit); vendorOutstanding is defined as (credit - debit) since creditor balances are credit-positive.
    assertClose(-ledger.closingBalance, row ? Number(row.outstanding) : 0, "Vendor Alpha ledger closing balance != vendorOutstanding (sign-adjusted)");
  });

  await check("reconcile: Vendor Beta party ledger closing balance matches vendorOutstanding", async () => {
    const ledger = await partyLedger("vendor", vendBeta.id, FAR_PAST, FAR_FUTURE);
    const row = (await vendorOutstanding()).find((r: any) => r.vendor_id === vendBeta.id);
    assertClose(-ledger.closingBalance, row ? Number(row.outstanding) : 0, "Vendor Beta ledger closing balance != vendorOutstanding (sign-adjusted)");
  });

  await check("reconcile: Trade Debtors control account (1200) = sum of our customers' ledger balances", async () => {
    const { rows } = await pool.query(
      `select coalesce(sum(jel.debit - jel.credit), 0) as bal
       from journal_entry_lines jel join journal_entries je on je.id = jel.journal_entry_id
       where jel.party_type = 'customer' and jel.party_id = any($1::bigint[]) and je.status = 'posted'`,
      [[custAlpha.id, custBeta.id]],
    );
    const controlBal = Number(rows[0].bal);
    const alphaLedger = await partyLedger("customer", custAlpha.id, FAR_PAST, FAR_FUTURE);
    const betaLedger = await partyLedger("customer", custBeta.id, FAR_PAST, FAR_FUTURE);
    assertClose(controlBal, alphaLedger.closingBalance + betaLedger.closingBalance, "Trade Debtors control account doesn't reconcile with the sum of party ledgers");
  });

  await check("reconcile: Trade Creditors control account (2100) = sum of our vendors' ledger balances", async () => {
    const { rows } = await pool.query(
      `select coalesce(sum(jel.debit - jel.credit), 0) as bal
       from journal_entry_lines jel join journal_entries je on je.id = jel.journal_entry_id
       where jel.party_type = 'vendor' and jel.party_id = any($1::bigint[]) and je.status = 'posted'`,
      [[vendAlpha.id, vendBeta.id]],
    );
    const controlBal = Number(rows[0].bal);
    const alphaLedger = await partyLedger("vendor", vendAlpha.id, FAR_PAST, FAR_FUTURE);
    const betaLedger = await partyLedger("vendor", vendBeta.id, FAR_PAST, FAR_FUTURE);
    assertClose(controlBal, alphaLedger.closingBalance + betaLedger.closingBalance, "Trade Creditors control account doesn't reconcile with the sum of party ledgers");
  });

  // ==================================================================
  // SECTION 10 — GST RECONCILIATION (mixed CGST/SGST/IGST + notes)
  // ==================================================================
  await check("gst: report totals reconcile against raw ledger movement, net of credit/debit note reversals", async () => {
    const report = await gstReport(FAR_PAST, FAR_FUTURE);

    const { rows: outRows } = await pool.query(
      `select coalesce(sum(jel.credit - jel.debit), 0) as net
       from journal_entry_lines jel join journal_entries je on je.id = jel.journal_entry_id
       join chart_of_accounts coa on coa.id = jel.account_id
       where je.status = 'posted' and coa.account_code in ('2151','2152','2153')`,
    );
    const { rows: inRows } = await pool.query(
      `select coalesce(sum(jel.debit - jel.credit), 0) as net
       from journal_entry_lines jel join journal_entries je on je.id = jel.journal_entry_id
       join chart_of_accounts coa on coa.id = jel.account_id
       where je.status = 'posted' and coa.account_code in ('1161','1162','1163')`,
    );
    const trueNetOutput = Number(outRows[0].net);
    const trueNetInput = Number(inRows[0].net);

    assertClose(
      report.totalOutput,
      trueNetOutput,
      `gstReport.totalOutput (${report.totalOutput}) does not match true net output tax (${trueNetOutput}) after credit-note reversals`,
    );
    assertClose(
      report.totalInput,
      trueNetInput,
      `gstReport.totalInput (${report.totalInput}) does not match true net input tax (${trueNetInput}) after debit-note reversals`,
    );
  });

  // ==================================================================
  // SECTION 11 — JOURNAL TRACEABILITY / ORPHAN DETECTION
  // ==================================================================
  await check("traceability: every posted/cancelled sales invoice's journal_entry_id resolves", async () => {
    const { rows } = await pool.query(
      `select si.id from sales_invoices si
       where si.status in ('posted','cancelled') and si.journal_entry_id is not null
         and not exists (select 1 from journal_entries je where je.id = si.journal_entry_id)`,
    );
    assert(rows.length === 0, `orphan sales invoices (journal_entry_id doesn't resolve): ${JSON.stringify(rows)}`);
  });

  await check("traceability: every posted/cancelled purchase invoice's journal_entry_id resolves", async () => {
    const { rows } = await pool.query(
      `select pi.id from purchase_invoices pi
       where pi.status in ('posted','cancelled') and pi.journal_entry_id is not null
         and not exists (select 1 from journal_entries je where je.id = pi.journal_entry_id)`,
    );
    assert(rows.length === 0, `orphan purchase invoices: ${JSON.stringify(rows)}`);
  });

  await check("traceability: every posted/cancelled receipt's journal_entry_id resolves", async () => {
    const { rows } = await pool.query(
      `select r.id from receipts r
       where r.status in ('posted','cancelled') and r.journal_entry_id is not null
         and not exists (select 1 from journal_entries je where je.id = r.journal_entry_id)`,
    );
    assert(rows.length === 0, `orphan receipts: ${JSON.stringify(rows)}`);
  });

  await check("traceability: every posted/cancelled payment's journal_entry_id resolves", async () => {
    const { rows } = await pool.query(
      `select p.id from payments p
       where p.status in ('posted','cancelled') and p.journal_entry_id is not null
         and not exists (select 1 from journal_entries je where je.id = p.journal_entry_id)`,
    );
    assert(rows.length === 0, `orphan payments: ${JSON.stringify(rows)}`);
  });

  await check("traceability: every posted/cancelled credit/debit note's journal_entry_id resolves", async () => {
    const { rows: cnRows } = await pool.query(
      `select cn.id from credit_notes cn
       where cn.status in ('posted','cancelled') and cn.journal_entry_id is not null
         and not exists (select 1 from journal_entries je where je.id = cn.journal_entry_id)`,
    );
    const { rows: dnRows } = await pool.query(
      `select dn.id from debit_notes dn
       where dn.status in ('posted','cancelled') and dn.journal_entry_id is not null
         and not exists (select 1 from journal_entries je where je.id = dn.journal_entry_id)`,
    );
    assert(cnRows.length === 0, `orphan credit notes: ${JSON.stringify(cnRows)}`);
    assert(dnRows.length === 0, `orphan debit notes: ${JSON.stringify(dnRows)}`);
  });

  await check("traceability: no journal entry's source_type/source_id points at a non-existent source row", async () => {
    const { rows } = await pool.query(
      `select je.id, je.source_type, je.source_id from journal_entries je
       where je.source_type = 'invoice' and je.source_id is not null
         and not exists (select 1 from sales_invoices si where si.id = je.source_id)
       union all
       select je.id, je.source_type, je.source_id from journal_entries je
       where je.source_type = 'purchase' and je.source_id is not null
         and not exists (select 1 from purchase_invoices pi where pi.id = je.source_id)
       union all
       select je.id, je.source_type, je.source_id from journal_entries je
       where je.source_type = 'receipt' and je.source_id is not null
         and not exists (select 1 from receipts r where r.id = je.source_id)
       union all
       select je.id, je.source_type, je.source_id from journal_entries je
       where je.source_type = 'payment' and je.source_id is not null
         and not exists (select 1 from payments p where p.id = je.source_id)
       union all
       select je.id, je.source_type, je.source_id from journal_entries je
       where je.source_type = 'credit_note' and je.source_id is not null
         and not exists (select 1 from credit_notes cn where cn.id = je.source_id)
       union all
       select je.id, je.source_type, je.source_id from journal_entries je
       where je.source_type = 'debit_note' and je.source_id is not null
         and not exists (select 1 from debit_notes dn where dn.id = je.source_id)`,
    );
    assert(rows.length === 0, `journal entries with unresolved source: ${JSON.stringify(rows)}`);
  });

  await check("orphan check: every 'cancelled' journal entry has a resolvable reversed_by_je_id", async () => {
    const { rows } = await pool.query(
      `select id, je_no from journal_entries je
       where status = 'cancelled'
         and (reversed_by_je_id is null or not exists (select 1 from journal_entries r where r.id = je.reversed_by_je_id))`,
    );
    assert(rows.length === 0, `cancelled journal entries with no resolvable reversal: ${JSON.stringify(rows)}`);
  });

  await check("orphan check: every reversal journal entry has a resolvable reverses_je_id", async () => {
    const { rows } = await pool.query(
      `select id, je_no from journal_entries je
       where source_type = 'reversal'
         and (reverses_je_id is null or not exists (select 1 from journal_entries o where o.id = je.reverses_je_id))`,
    );
    assert(rows.length === 0, `reversal journal entries with no resolvable original: ${JSON.stringify(rows)}`);
  });

  await check("orphan check: no receipt_allocations row points at a cancelled sales invoice", async () => {
    const { rows } = await pool.query(
      `select ra.id from receipt_allocations ra
       join sales_invoices si on si.id = ra.sales_invoice_id
       where si.status = 'cancelled'`,
    );
    assert(rows.length === 0, `receipt_allocations pointing at cancelled invoices (stale data): ${JSON.stringify(rows)}`);
  });

  await check("orphan check: no payment_allocations row points at a cancelled purchase invoice", async () => {
    const { rows } = await pool.query(
      `select pa.id from payment_allocations pa
       join purchase_invoices pi on pi.id = pa.purchase_invoice_id
       where pi.status = 'cancelled'`,
    );
    assert(rows.length === 0, `payment_allocations pointing at cancelled purchase invoices (stale data): ${JSON.stringify(rows)}`);
  });

  await check("orphan check: no receipt_allocations row belongs to a cancelled receipt", async () => {
    const { rows } = await pool.query(
      `select ra.id from receipt_allocations ra
       join receipts r on r.id = ra.receipt_id
       where r.status = 'cancelled'`,
    );
    assert(rows.length === 0, `receipt_allocations belonging to cancelled receipts (stale data): ${JSON.stringify(rows)}`);
  });

  await check("orphan check: no payment_allocations row belongs to a cancelled payment", async () => {
    const { rows } = await pool.query(
      `select pa.id from payment_allocations pa
       join payments p on p.id = pa.payment_id
       where p.status = 'cancelled'`,
    );
    assert(rows.length === 0, `payment_allocations belonging to cancelled payments (stale data): ${JSON.stringify(rows)}`);
  });

  await check("orphan check: no journal_entry_lines row references a non-existent chart-of-accounts row", async () => {
    const { rows } = await pool.query(
      `select jel.id from journal_entry_lines jel
       where not exists (select 1 from chart_of_accounts coa where coa.id = jel.account_id)`,
    );
    assert(rows.length === 0, `journal_entry_lines with unresolved account_id: ${JSON.stringify(rows)}`);
  });

  await check("posting engine discipline: every posted journal entry's lines balance exactly", async () => {
    const { rows } = await pool.query(
      `select je.id, je.je_no, sum(jel.debit) as d, sum(jel.credit) as c
       from journal_entries je join journal_entry_lines jel on jel.journal_entry_id = je.id
       where je.status = 'posted'
       group by je.id, je.je_no
       having round(sum(jel.debit)::numeric,2) != round(sum(jel.credit)::numeric,2)`,
    );
    assert(rows.length === 0, `unbalanced posted journal entries found: ${JSON.stringify(rows)}`);
  });

  // ==================================================================
  // SECTION 12 — TRIAL BALANCE / P&L / BALANCE SHEET SANITY
  // ==================================================================
  await check("reports: final trial balance balances", async () => {
    const tb = await trialBalance(todayISO());
    assert(tb.balanced, `Trial balance out of balance: debit ${tb.debitTotal} vs credit ${tb.creditTotal}`);
  });

  await check("reports: balance sheet balances (assets = liabilities + equity)", async () => {
    const bs = await balanceSheet(todayISO());
    assert(bs.balanced, `Balance sheet out of balance: assets ${bs.totalAssets} vs liab+equity ${bs.totalLiabilities + bs.totalEquity}`);
  });

  await check("reports: P&L computes a valid number for the test period", async () => {
    const pnl = await profitAndLoss(todayISO(), todayISO());
    assert(typeof pnl.profitOrLoss === "number" && !Number.isNaN(pnl.profitOrLoss), "P&L profitOrLoss is not a valid number");
  });

  await check("reports: day book includes every voucher type created in this run", async () => {
    const book = await dayBook(todayISO(), todayISO());
    const sourceTypes = new Set(book.map((r: any) => r.source_type));
    for (const expected of ["invoice", "purchase", "receipt", "payment", "credit_note", "debit_note", "contra"]) {
      assert(sourceTypes.has(expected), `day book is missing source_type '${expected}'`);
    }
  });

  // ==================================================================
  // SECTION 13 — PATCH REGRESSION PROTECTION
  // (Self Acceptance Testing found two defects not caught by any test
  // above; these tests exist specifically so both can never silently
  // regress.)
  // ==================================================================

  // ---- Defect 1: trialBalance()/balanceSheet() must actually respect asOfDate ----
  const { rows: fyRowsForPatch } = await pool.query(
    `select start_date from financial_years where $1::date between start_date and end_date`,
    [todayISO()],
  );
  assert(fyRowsForPatch.length > 0, "no open financial year covers today — cannot run historical-date regression tests");
  const historicalDate: string = fyRowsForPatch[0].start_date.toISOString().slice(0, 10);

  await check("reports: trial balance as of the financial year's start date excludes today's postings", async () => {
    const tbHistorical = await trialBalance(historicalDate);
    const tbToday = await trialBalance(todayISO());
    assert(
      tbHistorical.debitTotal < tbToday.debitTotal,
      `historical (${tbHistorical.debitTotal}) should be strictly less than today's (${tbToday.debitTotal}) — ` +
        `if equal, asOfDate is being ignored (this is the exact defect SAT found)`,
    );
  });

  await check("reports: balance sheet as of the financial year's start date excludes today's postings", async () => {
    const bsHistorical = await balanceSheet(historicalDate);
    const bsToday = await balanceSheet(todayISO());
    assert(
      bsHistorical.totalAssets < bsToday.totalAssets,
      `historical totalAssets (${bsHistorical.totalAssets}) should be strictly less than today's (${bsToday.totalAssets}) — ` +
        `if equal, asOfDate is being ignored`,
    );
  });

  await check("reports: trial balance balances at a historical reporting date, not just today", async () => {
    const tbHistorical = await trialBalance(historicalDate);
    assert(
      tbHistorical.balanced,
      `historical trial balance should balance: debit ${tbHistorical.debitTotal} vs credit ${tbHistorical.creditTotal}`,
    );
  });

  await check("reports: balance sheet balances at a historical reporting date, not just today", async () => {
    const bsHistorical = await balanceSheet(historicalDate);
    assert(
      bsHistorical.balanced,
      `historical balance sheet should balance: assets ${bsHistorical.totalAssets} vs ` +
        `liab+equity ${bsHistorical.totalLiabilities + bsHistorical.totalEquity}`,
    );
  });

  await check("reports: trial balance and balance sheet as of today are still correct after the fix", async () => {
    const tbToday = await trialBalance(todayISO());
    const bsToday = await balanceSheet(todayISO());
    assert(tbToday.balanced, `today's trial balance should balance: debit ${tbToday.debitTotal} vs credit ${tbToday.creditTotal}`);
    assert(
      bsToday.balanced,
      `today's balance sheet should balance: assets ${bsToday.totalAssets} vs liab+equity ${bsToday.totalLiabilities + bsToday.totalEquity}`,
    );
  });

  // ---- Defect 2: allocations must be validated against actual invoice/purchase outstanding ----
  const custGamma = (await pool.query(
    `insert into customers (customer_name, supply_type) values ($1,'intrastate') returning *`,
    [`TestCo Gamma ${RUN}`],
  )).rows[0];

  const invG1 = await withTransaction((c) =>
    createDraftSalesInvoice(c, {
      customerId: custGamma.id,
      invoiceDate: todayISO(),
      lines: [{ description: "G1", qty: 1, rate: 1000, gstRate: 18 }], // total 1180
      userId,
    }),
  );
  await withTransaction((c) => postSalesInvoice(c, invG1.id, userId));

  const invG2 = await withTransaction((c) =>
    createDraftSalesInvoice(c, {
      customerId: custGamma.id,
      invoiceDate: todayISO(),
      lines: [{ description: "G2", qty: 1, rate: 2000, gstRate: 18 }], // total 2360
      userId,
    }),
  );
  await withTransaction((c) => postSalesInvoice(c, invG2.id, userId));

  await check("allocation: exact allocation to a single invoice succeeds and fully settles it", async () => {
    const draft = await withTransaction((c) =>
      createDraftReceipt(c, {
        customerId: custGamma.id,
        receiptDate: todayISO(),
        amount: 1180,
        bankAccountCode: "1100",
        allocations: [{ salesInvoiceId: invG1.id, allocatedAmount: 1180 }],
        userId,
      }),
    );
    await withTransaction((c) => postReceipt(c, draft.id, userId));
    const outstanding = (await customerOutstanding()).find((r: any) => r.customer_id === custGamma.id);
    assertClose(outstanding ? Number(outstanding.outstanding) : 0, 2360, "Gamma outstanding should be exactly G2's total after G1 is exactly settled");
  });

  await check("allocation: partial allocation succeeds and leaves the correct remaining balance", async () => {
    const draft = await withTransaction((c) =>
      createDraftReceipt(c, {
        customerId: custGamma.id,
        receiptDate: todayISO(),
        amount: 1000,
        bankAccountCode: "1100",
        allocations: [{ salesInvoiceId: invG2.id, allocatedAmount: 1000 }],
        userId,
      }),
    );
    await withTransaction((c) => postReceipt(c, draft.id, userId));
    const outstanding = (await customerOutstanding()).find((r: any) => r.customer_id === custGamma.id);
    assertClose(outstanding ? Number(outstanding.outstanding) : 0, 1360, "Gamma outstanding should be 1360 (2360 - 1000 partial) after partial allocation to G2");
  });

  await check("allocation: over-allocation against a single invoice's actual remaining balance is rejected (SAT defect #2)", async () => {
    await assertThrowsInstance(
      () =>
        withTransaction((c) =>
          createDraftReceipt(c, {
            customerId: custGamma.id,
            receiptDate: todayISO(),
            amount: 2000,
            bankAccountCode: "1100",
            allocations: [{ salesInvoiceId: invG2.id, allocatedAmount: 2000 }], // G2's true remaining is only 1360
            userId,
          }),
        ),
      ReceiptAllocationExceedsOutstandingError,
      "allocating 2000 to G2 (remaining balance 1360) should be rejected even though 2000 <= the receipt's own amount",
    );
  });

  const invG3 = await withTransaction((c) =>
    createDraftSalesInvoice(c, {
      customerId: custGamma.id,
      invoiceDate: todayISO(),
      lines: [{ description: "G3", qty: 1, rate: 500, gstRate: 18 }], // total 590
      userId,
    }),
  );
  await withTransaction((c) => postSalesInvoice(c, invG3.id, userId));

  const invG4 = await withTransaction((c) =>
    createDraftSalesInvoice(c, {
      customerId: custGamma.id,
      invoiceDate: todayISO(),
      lines: [{ description: "G4", qty: 1, rate: 1000, gstRate: 18 }], // total 1180
      userId,
    }),
  );
  await withTransaction((c) => postSalesInvoice(c, invG4.id, userId));

  await check("allocation: multi-invoice allocation in a single receipt still works and settles both exactly", async () => {
    const draft = await withTransaction((c) =>
      createDraftReceipt(c, {
        customerId: custGamma.id,
        receiptDate: todayISO(),
        amount: 1770, // 590 + 1180
        bankAccountCode: "1100",
        allocations: [
          { salesInvoiceId: invG3.id, allocatedAmount: 590 },
          { salesInvoiceId: invG4.id, allocatedAmount: 1180 },
        ],
        userId,
      }),
    );
    await withTransaction((c) => postReceipt(c, draft.id, userId));
    const outstanding = (await customerOutstanding()).find((r: any) => r.customer_id === custGamma.id);
    assertClose(outstanding ? Number(outstanding.outstanding) : 0, 1360, "only G2's remaining 1360 should still be outstanding after G3+G4 are settled in one multi-invoice receipt");
  });

  await check("allocation: remaining balance verification — G2's remaining balance is exactly 1360 after its partial allocation", async () => {
    const { rows } = await pool.query(
      `select coalesce(sum(ra.allocated_amount),0) as allocated
       from receipt_allocations ra join receipts r on r.id = ra.receipt_id
       where ra.sales_invoice_id = $1 and r.status != 'cancelled'`,
      [invG2.id],
    );
    const allocated = Number(rows[0].allocated);
    assertClose(Number(invG2.total) - allocated, 1360, "G2 remaining balance should be exactly 1360");
  });

  // ---- Mirror coverage on the payments/vendor side ----
  const vendGamma = (await pool.query(
    `insert into vendors (vendor_name, supply_type) values ($1,'intrastate') returning *`,
    [`VendorCo Gamma ${RUN}`],
  )).rows[0];

  const purG1 = await withTransaction((c) =>
    createDraftPurchaseInvoice(c, {
      vendorId: vendGamma.id,
      invoiceDate: todayISO(),
      vendorInvoiceNo: `VG-${RUN}-1`,
      lines: [{ description: "PG1", qty: 1, rate: 1000, gstRate: 18 }], // total 1180
      userId,
    }),
  );
  await withTransaction((c) => postPurchaseInvoice(c, purG1.id, userId));

  await check("allocation (payments): partial allocation to a purchase invoice succeeds and leaves the correct remaining balance", async () => {
    const draft = await withTransaction((c) =>
      createDraftPayment(c, {
        vendorId: vendGamma.id,
        paymentDate: todayISO(),
        amount: 500,
        bankAccountCode: "1100",
        allocations: [{ purchaseInvoiceId: purG1.id, allocatedAmount: 500 }],
        userId,
      }),
    );
    await withTransaction((c) => postPayment(c, draft.id, userId));
    const outstanding = (await vendorOutstanding()).find((r: any) => r.vendor_id === vendGamma.id);
    assertClose(outstanding ? Number(outstanding.outstanding) : 0, 680, "Vendor Gamma outstanding should be 680 (1180 - 500) after partial payment allocation");
  });

  await check("allocation (payments): over-allocation against a purchase invoice's actual remaining balance is rejected (SAT defect #2)", async () => {
    await assertThrowsInstance(
      () =>
        withTransaction((c) =>
          createDraftPayment(c, {
            vendorId: vendGamma.id,
            paymentDate: todayISO(),
            amount: 1000,
            bankAccountCode: "1100",
            allocations: [{ purchaseInvoiceId: purG1.id, allocatedAmount: 1000 }], // remaining is only 680
            userId,
          }),
        ),
      PaymentAllocationExceedsOutstandingError,
      "allocating 1000 to purchase G1 (remaining balance 680) should be rejected even though 1000 <= the payment's own amount",
    );
  });

  // ==================================================================
  // SUMMARY
  // ==================================================================
  const failed = results.filter((r) => !r.pass);
  console.log("\n==================== SUMMARY ====================");
  console.log(`Total: ${results.length}   Passed: ${results.length - failed.length}   Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failed) console.log(`  - ${f.name}\n    ${f.detail}`);
  }
  console.log("==================================================\n");

  await pool.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("FATAL — test runner crashed before completing:", err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
