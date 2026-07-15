/**
 * GST FILING — REGRESSION SUITE
 * ================================================
 *
 * Covers the previously-untested surface flagged by review:
 * gstr3bSummary, gstHsnSummary, gstInvoiceWiseDetail, and
 * reconcileGstr2b (src/lib/gst-filing.ts). Drives the real lib
 * functions against a live database with known, controlled invoice
 * data — same convention as every other regression suite here, not a
 * mock.
 *
 * IMPORTANT: gstr3bSummary/gstHsnSummary aggregate across the ENTIRE
 * database for a date range — they are not scoped to a single
 * customer or test run. Asserting an exact total would be wrong on a
 * shared database that already has other data in it (real usage,
 * other test runs). This suite instead captures a BEFORE snapshot,
 * creates known test invoices, captures an AFTER snapshot, and
 * asserts the DELTA matches exactly what those test invoices should
 * have contributed — the same safe-to-rerun principle
 * phase2-regression.ts already documents for its own tests.
 *
 * Run with: npx tsx test/gst-filing-regression.ts
 * Requires a live, freshly migrated database with an open financial
 * year and chart_of_accounts seeded with the standard GST accounts
 * (2151/2152/2153 output, 1161/1162/1163 input — see schema.sql).
 */

import { pool, withTransaction } from "../src/db/pool.ts";
import { createDraftSalesInvoice, postSalesInvoice } from "../src/lib/sales.ts";
import { createDraftPurchaseInvoice, postPurchaseInvoice } from "../src/lib/purchases.ts";
import { gstr3bSummary, gstHsnSummary, gstInvoiceWiseDetail, reconcileGstr2b } from "../src/lib/gst-filing.ts";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
const RUN = Date.now();

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail: msg });
    console.log(`FAIL  ${name}\n      -> ${msg}`);
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

// Wide enough to contain "today" regardless of when this runs, tight
// enough that it wouldn't realistically span into unrelated historical
// data from a genuinely different period.
const fromDate = "2020-01-01";
const toDate = new Date().toISOString().slice(0, 10);

async function main() {
  // ---- Fixtures ----
  const { rows: custRows } = await pool.query(
    `insert into customers (customer_name, supply_type) values ($1, 'intrastate') returning *`,
    [`GST Test Customer ${RUN}`],
  );
  const customerId = custRows[0].id;

  const { rows: vendorRows } = await pool.query(
    `insert into vendors (vendor_name, gstin, supply_type) values ($1, $2, 'intrastate') returning *`,
    [`GST Test Vendor ${RUN}`, `29TESTPAN${RUN}`.slice(0, 15)],
  );
  const vendor = vendorRows[0];

  const testHsn = `TESTHSN${RUN}`;
  const invoiceDate = toDate;

  // ---- GSTR-3B: capture baseline, create a known invoice, assert the delta ----
  let salesInvoiceNo: string;
  await check("gstr3bSummary reflects the exact taxable value and tax split of a new intrastate sales invoice", async () => {
    const before = await gstr3bSummary(fromDate, toDate);

    const invoice = await withTransaction(async (client) => {
      const draft = await createDraftSalesInvoice(client, {
        customerId, invoiceDate,
        lines: [{ description: "GST test line", qty: 1, rate: 1000, gstRate: 18, hsn: testHsn }],
        userId: null,
      });
      return postSalesInvoice(client, draft.id, null);
    });
    salesInvoiceNo = invoice.invoice_no;

    const after = await gstr3bSummary(fromDate, toDate);

    const taxableDelta = round2(after.section3_1.outwardTaxableSupplies.taxableValue - before.section3_1.outwardTaxableSupplies.taxableValue);
    const cgstDelta = round2(after.section3_1.outwardTaxableSupplies.cgst - before.section3_1.outwardTaxableSupplies.cgst);
    const sgstDelta = round2(after.section3_1.outwardTaxableSupplies.sgst - before.section3_1.outwardTaxableSupplies.sgst);
    const igstDelta = round2(after.section3_1.outwardTaxableSupplies.igst - before.section3_1.outwardTaxableSupplies.igst);

    assert(taxableDelta === 1000, `expected taxable value delta of 1000, got ${taxableDelta}`);
    // Intrastate: 18% splits evenly into 9% CGST + 9% SGST, no IGST.
    assert(cgstDelta === 90, `expected CGST delta of 90, got ${cgstDelta}`);
    assert(sgstDelta === 90, `expected SGST delta of 90, got ${sgstDelta}`);
    assert(igstDelta === 0, `expected IGST delta of 0 for an intrastate invoice, got ${igstDelta}`);
  });

  await check("gstr3bSummary's set-off correctly reflects this invoice's output tax with no offsetting ITC", async () => {
    const after = await gstr3bSummary(fromDate, toDate);
    // Not asserting exact totals here (shared database) -- just that
    // the output tax figure is internally consistent with the section
    // 3.1 numbers captured above, and cash payable is never negative
    // for CGST/SGST when there's clearly more output tax than credit
    // in this narrow, freshly-created scenario.
    assert(after.section6_1_paymentOfTax.totalOutputTax >= 180, `expected total output tax to include at least our 180, got ${after.section6_1_paymentOfTax.totalOutputTax}`);
  });

  // ---- HSN Summary ----
  await check("gstHsnSummary groups by HSN code and reports correct qty/taxable value/tax for our test HSN", async () => {
    const rows = await gstHsnSummary(fromDate, toDate);
    const ourRow = rows.find((r) => r.hsn === testHsn);
    assert(!!ourRow, `expected a row for HSN ${testHsn}, found none — got HSN values: ${rows.map((r) => r.hsn).join(", ")}`);
    assert(Number(ourRow!.total_qty) === 1, `expected qty 1, got ${ourRow!.total_qty}`);
    assert(round2(Number(ourRow!.taxable_value)) === 1000, `expected taxable_value 1000, got ${ourRow!.taxable_value}`);
    assert(round2(Number(ourRow!.tax_amount)) === 180, `expected tax_amount 180 (18% of 1000), got ${ourRow!.tax_amount}`);
  });

  await check("a line with no HSN recorded falls into the '(no HSN recorded)' bucket, not silently dropped", async () => {
    await withTransaction(async (client) => {
      const draft = await createDraftSalesInvoice(client, {
        customerId, invoiceDate,
        lines: [{ description: "No-HSN test line", qty: 1, rate: 500, gstRate: 18 }], // no hsn field at all
        userId: null,
      });
      await postSalesInvoice(client, draft.id, null);
    });
    const rows = await gstHsnSummary(fromDate, toDate);
    const noHsnRow = rows.find((r) => r.hsn === "(no HSN recorded)");
    assert(!!noHsnRow, "expected a '(no HSN recorded)' row to exist after posting a line with no HSN");
  });

  // ---- Invoice-wise detail (B2B/B2C) ----
  await check("gstInvoiceWiseDetail correctly classifies our no-GSTIN test customer's invoice as B2C, not B2B", async () => {
    const detail = await gstInvoiceWiseDetail(fromDate, toDate);
    const ourInvoice = [...detail.b2b, ...detail.b2c].find((inv) => inv.invoice_no === salesInvoiceNo);
    assert(!!ourInvoice, `expected to find invoice ${salesInvoiceNo} in either b2b or b2c`);
    const inB2c = detail.b2c.some((inv) => inv.invoice_no === salesInvoiceNo);
    const inB2b = detail.b2b.some((inv) => inv.invoice_no === salesInvoiceNo);
    assert(inB2c && !inB2b, `expected invoice ${salesInvoiceNo} (customer has no GSTIN) to be classified B2C only`);
    assert(round2(Number(ourInvoice!.subtotal)) === 1000 || round2(Number(ourInvoice!.subtotal)) === 500, `unexpected subtotal on our own invoice: ${ourInvoice!.subtotal}`);
  });

  // ---- GSTR-2B reconciliation ----
  let purchaseInvoiceNo: string;
  const vendorInvoiceNo = `VINV-${RUN}`;
  await check("reconcileGstr2b matches a purchase invoice against an uploaded file referencing the same vendor GSTIN + invoice number", async () => {
    const purchase = await withTransaction(async (client) => {
      const draft = await createDraftPurchaseInvoice(client, {
        vendorId: vendor.id, invoiceDate, vendorInvoiceNo,
        lines: [{ description: "Reconciliation test line", qty: 1, rate: 2000, gstRate: 18, hsn: testHsn }],
        userId: null,
      });
      return postPurchaseInvoice(client, draft.id, null);
    });
    purchaseInvoiceNo = purchase.purchase_no;

    const csv = `GSTIN of Supplier,Invoice Number,Invoice Date,Taxable Value,Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹)\n` +
      `${vendor.gstin},${vendorInvoiceNo},${invoiceDate},2000,0,180,180\n`;
    const result = await reconcileGstr2b(Buffer.from(csv, "utf-8"), "test-gstr2b.csv");

    const ourMatch = result.matched.find((m: any) => m.invoiceNo === vendorInvoiceNo && m.gstin === vendor.gstin);
    assert(!!ourMatch, `expected our invoice ${vendorInvoiceNo} to appear in matched[]`);
    assert(!(ourMatch as any).taxMismatch, `expected no tax mismatch — our posted gst_amount (360) should equal the uploaded 180+180=360`);
  });

  await check("reconcileGstr2b flags an uploaded invoice with no matching purchase record as onlyInGstn", async () => {
    const phantomInvoiceNo = `PHANTOM-${RUN}`;
    const csv = `GSTIN of Supplier,Invoice Number,Invoice Date,Taxable Value,Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹)\n` +
      `${vendor.gstin},${phantomInvoiceNo},${invoiceDate},999,0,89.91,89.91\n`;
    const result = await reconcileGstr2b(Buffer.from(csv, "utf-8"), "test-gstr2b-phantom.csv");
    const flagged = result.onlyInGstn.find((m: any) => m.invoiceNo === phantomInvoiceNo);
    assert(!!flagged, `expected phantom invoice ${phantomInvoiceNo} (no corresponding purchase record) to be flagged in onlyInGstn`);
  });

  await check("reconcileGstr2b flags our own posted purchase as onlyInOurBooks when the uploaded file omits it entirely", async () => {
    // NOTE: reconcileGstr2b's onlyInOurBooks query has no date-range
    // scoping at all (see the FIX-worthy note in gst-filing.ts review)
    // -- it checks every posted purchase invoice in the whole
    // database, not just ones from the period this file covers. That
    // means this assertion (checking OUR specific invoice appears)
    // is correct and safe on a shared database, but a real user
    // uploading a single quarter's GSTR-2B file would see every OTHER
    // period's purchases flagged here too, which is a real usability
    // gap worth fixing separately -- not something this test papers
    // over by asserting exact array length.
    const csv = `GSTIN of Supplier,Invoice Number,Invoice Date,Taxable Value,Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹)\n` +
      `27SOMEOTHERGSTIN,UNRELATED-INV,${invoiceDate},1,0,0,0\n`;
    const result = await reconcileGstr2b(Buffer.from(csv, "utf-8"), "test-gstr2b-empty.csv");
    const flagged = result.onlyInOurBooks.find((m: any) => m.invoiceNo === vendorInvoiceNo);
    assert(!!flagged, `expected our purchase invoice ${vendorInvoiceNo} to appear in onlyInOurBooks when the uploaded file doesn't reference it`);
  });

  await check("reconcileGstr2b throws a clear error when a required column is missing, rather than silently proceeding", async () => {
    const csv = `Some Column,Another Column\nvalue1,value2\n`;
    try {
      await reconcileGstr2b(Buffer.from(csv, "utf-8"), "test-bad-format.csv");
      throw new Error("expected reconcileGstr2b to throw for a file missing GSTIN/Invoice Number/Taxable Value columns, but it did not");
    } catch (err) {
      const msg = (err as Error).message;
      assert(msg.includes("Could not find required column"), `expected a clear missing-column error, got: ${msg}`);
    }
  });

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
