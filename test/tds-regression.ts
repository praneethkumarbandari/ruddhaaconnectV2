/**
 * TDS — REGRESSION SUITE
 * ================================================
 *
 * Covers the highest-risk, previously-untested surface flagged by
 * review: TDS threshold crossing (both single-payment and FY
 * aggregate), correct GL posting when TDS is withheld, and the
 * reversal fix (cancelPayment() now correctly reverses the
 * tds_deductions row instead of leaving a cancelled payment's
 * deduction sitting in the register as if it genuinely happened).
 *
 * Drives the real lib functions directly against a live database,
 * same convention as phase2-regression.ts — not a mock.
 *
 * Run with: npx tsx test/tds-regression.ts
 * Requires a live, freshly migrated database (through
 * schema-tds-reversal.sql at minimum) with an open financial year.
 */

import { pool, withTransaction } from "../src/db/pool.ts";
import { createDraftPayment, postPayment, cancelPayment } from "../src/lib/payments.ts";

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

async function main() {
  // ---- Test fixtures: a fresh vendor, a bank account, a TDS section ----
  const { rows: vendorRows } = await pool.query(
    `insert into vendors (vendor_name, supply_type) values ($1,'intrastate') returning *`,
    [`TDS Test Vendor ${RUN}`],
  );
  const vendorId = vendorRows[0].id;

  const { rows: bankRows } = await pool.query(`select account_code from chart_of_accounts where account_code = '1100' limit 1`);
  assert(bankRows.length > 0, "expected a bank account (1100) to exist — check schema.sql seeding");
  const bankAccountCode = bankRows[0].account_code;

  // A dedicated, low-threshold test section so tests don't depend on
  // (and can't be broken by) whatever real 194C/194J rows exist.
  const { rows: sectionRows } = await pool.query(
    `insert into tds_sections (section_code, section_name, rate_percentage, threshold_single_payment, threshold_aggregate_annual)
     values ($1, 'Test Section', 10.00, 10000.00, 50000.00) returning *`,
    [`TEST_SEC_${RUN}`],
  );
  const tdsSectionId = sectionRows[0].id;

  const today = new Date().toISOString().slice(0, 10);

  // ---- Threshold: below both thresholds -> no TDS ----
  let belowThresholdPaymentId: number;
  await check("payment below both thresholds deducts no TDS", async () => {
    const result = await withTransaction((client) =>
      createDraftPayment(client, {
        vendorId, paymentDate: today, amount: 5000, bankAccountCode,
        allocations: [], userId: null, tdsSectionId,
      }),
    );
    assert(Number(result.tds_amount) === 0, `expected tds_amount 0, got ${result.tds_amount}`);
    belowThresholdPaymentId = result.id;
  });

  // ---- Threshold: single payment exceeds threshold_single_payment -> TDS applies to FULL amount ----
  let overThresholdPaymentId: number;
  await check("payment exceeding single-payment threshold deducts TDS on the FULL amount, not just the excess", async () => {
    const result = await withTransaction((client) =>
      createDraftPayment(client, {
        vendorId, paymentDate: today, amount: 15000, bankAccountCode,
        allocations: [], userId: null, tdsSectionId,
      }),
    );
    // 15000 > 10000 threshold -> 10% of the FULL 15000 = 1500, not 10% of (15000-10000)=500.
    assert(Number(result.tds_amount) === 1500, `expected tds_amount 1500 (10% of full 15000), got ${result.tds_amount}`);
    overThresholdPaymentId = result.id;
  });

  // ---- Threshold: aggregate crossing. Two payments individually below
  // the single-payment threshold, but together crossing the annual
  // aggregate threshold, must trigger TDS on the payment that crosses it. ----
  await check("aggregate FY-to-date threshold crossing triggers TDS even when no single payment exceeds the per-payment threshold", async () => {
    const { rows: v2 } = await pool.query(
      `insert into vendors (vendor_name, supply_type) values ($1,'intrastate') returning *`,
      [`TDS Aggregate Test Vendor ${RUN}`],
    );
    const aggVendorId = v2[0].id;

    // First payment: 9000, below both thresholds (10000 single, 50000 aggregate) -> no TDS.
    const first = await withTransaction((client) =>
      createDraftPayment(client, { vendorId: aggVendorId, paymentDate: today, amount: 9000, bankAccountCode, allocations: [], userId: null, tdsSectionId }),
    );
    assert(Number(first.tds_amount) === 0, `expected first payment tds_amount 0, got ${first.tds_amount}`);

    // Five more payments of 9000 each: running total after each:
    // 18000, 27000, 36000, 45000, 54000 -> the 5th (bringing total to
    // 54000) crosses the 50000 aggregate threshold and must deduct
    // TDS on its own full 9000, even though 9000 alone never exceeds
    // the 10000 single-payment threshold.
    let lastResult;
    for (let i = 0; i < 4; i++) {
      lastResult = await withTransaction((client) =>
        createDraftPayment(client, { vendorId: aggVendorId, paymentDate: today, amount: 9000, bankAccountCode, allocations: [], userId: null, tdsSectionId }),
      );
    }
    assert(Number(lastResult!.tds_amount) === 0, `expected 4th payment (total 45000, still under 50000) tds_amount 0, got ${lastResult!.tds_amount}`);

    const fifth = await withTransaction((client) =>
      createDraftPayment(client, { vendorId: aggVendorId, paymentDate: today, amount: 9000, bankAccountCode, allocations: [], userId: null, tdsSectionId }),
    );
    assert(Number(fifth.tds_amount) === 900, `expected 5th payment (total 54000, crosses 50000) to deduct 10% of its own 9000 = 900, got ${fifth.tds_amount}`);
  });

  // ---- Posting: verify the GL entry actually balances and splits correctly ----
  await check("posting a TDS-bearing payment produces a balanced entry split across vendor/bank/TDS payable", async () => {
    const { rows: configRows } = await pool.query(`select tds_payable_account_code from portal_config limit 1`);
    if (!configRows[0]?.tds_payable_account_code) {
      throw new Error("SKIPPED (not a failure): no tds_payable_account_code configured in portal_config — set one in Settings to exercise this test.");
    }
    const posted = await withTransaction((client) => postPayment(client, overThresholdPaymentId, null));
    assert(posted.status === "posted", `expected status 'posted', got '${posted.status}'`);

    const { rows: lineRows } = await pool.query(
      `select coa.account_code, jel.debit, jel.credit from journal_entry_lines jel
       join chart_of_accounts coa on coa.id = jel.account_id
       where jel.journal_entry_id = $1`,
      [posted.journal_entry_id],
    );
    const totalDebit = lineRows.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = lineRows.reduce((s, r) => s + Number(r.credit), 0);
    assert(Math.abs(totalDebit - totalCredit) < 0.01, `entry does not balance: debit=${totalDebit}, credit=${totalCredit}`);
    assert(totalDebit === 15000, `expected total debit 15000, got ${totalDebit}`);

    const tdsLine = lineRows.find((r) => Number(r.credit) === 1500);
    assert(!!tdsLine, "expected a credit line of exactly 1500 (the TDS withheld amount)");
  });

  // ---- THE FIX: cancelling a TDS-bearing payment must reverse the deduction ----
  await check("cancelling a posted TDS-bearing payment marks its tds_deductions row reversed", async () => {
    const { rows: beforeCancel } = await pool.query(
      `select reversed_at from tds_deductions where payment_id = $1`,
      [overThresholdPaymentId],
    );
    assert(beforeCancel.length === 1, `expected exactly one tds_deductions row for this payment, found ${beforeCancel.length}`);
    assert(beforeCancel[0].reversed_at === null, "expected reversed_at to be null before cancellation");

    await withTransaction((client) => cancelPayment(client, overThresholdPaymentId, null, "Test cancellation"));

    const { rows: afterCancel } = await pool.query(
      `select reversed_at from tds_deductions where payment_id = $1`,
      [overThresholdPaymentId],
    );
    assert(afterCancel[0].reversed_at !== null, "expected reversed_at to be set after cancellation — this is the exact bug the review found and this fix addresses");
  });

  await check("a reversed TDS deduction is excluded from Form 16A / 26Q totals (queried the same way those routes do)", async () => {
    const { rows } = await pool.query(
      `select coalesce(sum(tds_amount), 0) as total from tds_deductions where payment_id = $1 and reversed_at is null`,
      [overThresholdPaymentId],
    );
    assert(Number(rows[0].total) === 0, `expected 0 (the only deduction for this payment is now reversed), got ${rows[0].total}`);
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
