import { pool, query } from "../db/pool.ts";

/**
 * Every function here reads ONLY from journal_entry_lines where the
 * parent journal_entries.status = 'posted'. Draft and cancelled
 * entries never affect a report. Nothing here writes anywhere, and
 * no report total is ever stored — recomputed from source every call,
 * per "reports are always derived, never stored".
 */

export async function generalLedger(accountCode: string, fromDate: string, toDate: string) {
  // Opening balance = every posted movement for this account strictly
  // before fromDate. Because opening balances are themselves posted
  // as a real journal entry (see postOpeningBalances in
  // posting-engine.ts, dated at the financial year's start), this
  // single sum already captures both the account's true opening
  // balance AND all prior-period movement — there is no separate
  // "opening_balance column" special case needed here.
  const { rows: openingRows } = await query(
    `select coalesce(sum(jel.debit - jel.credit), 0) as opening_balance
     from journal_entry_lines jel
     join journal_entries je on je.id = jel.journal_entry_id
     join chart_of_accounts coa on coa.id = jel.account_id
     where coa.account_code = $1
       and je.status = 'posted'
       and je.entry_date < $2`,
    [accountCode, fromDate],
  );
  const openingBalance = Number(openingRows[0].opening_balance);

  const { rows } = await query(
    `select
       je.entry_date,
       je.je_no,
       jel.narration,
       jel.debit,
       jel.credit,
       $4::numeric + sum(jel.debit - jel.credit) over (order by je.entry_date, je.id, jel.line_no) as running_balance
     from journal_entry_lines jel
     join journal_entries je on je.id = jel.journal_entry_id
     join chart_of_accounts coa on coa.id = jel.account_id
     where coa.account_code = $1
       and je.status = 'posted'
       and je.entry_date between $2 and $3
     order by je.entry_date, je.id, jel.line_no`,
    [accountCode, fromDate, toDate, openingBalance],
  );

  return {
    openingBalance,
    movements: rows,
    closingBalance: rows.length > 0 ? Number(rows[rows.length - 1].running_balance) : openingBalance,
  };
}

/**
 * FIX (performance/scalability): General Ledger's "show everything"
 * view used to call generalLedger()/partyLedger() once PER LEDGER —
 * one HTTP round trip and one pair of SQL queries per account, per
 * customer, per vendor, per bank account. Fine at a handful of
 * ledgers; at "thousands of customers" (the actual target this needs
 * to hold up at) that's thousands of round trips for one page load.
 *
 * This is the batched replacement: a FIXED number of queries — two
 * for chart_of_accounts (opening + movements), two for customers, two
 * for vendors — regardless of how many individual ledgers exist,
 * using the exact same pre-filter-subquery pattern already
 * established in trialBalance() above (filter jel/je together in a
 * subquery so the date/status condition actually restricts which
 * rows are summed, before left-joining the filtered result out to
 * every account/party). Running balances are then computed in one
 * pass over each already-sorted, already-grouped array in JS, seeded
 * from that group's own opening balance — no per-row correlated
 * subquery, no window function fighting a variable partition key.
 */
export async function generalLedgerBatch(fromDate: string, toDate: string) {
  const [openingByCoa, movementsByCoa, openingByCustomer, movementsByCustomer, openingByVendor, movementsByVendor] =
    await Promise.all([
      query(
        `select coa.account_code, coalesce(sum(m.debit - m.credit), 0) as opening_balance
         from chart_of_accounts coa
         left join (
           select jel.account_id, jel.debit, jel.credit
           from journal_entry_lines jel
           join journal_entries je on je.id = jel.journal_entry_id
           where je.status = 'posted' and je.entry_date < $1
         ) m on m.account_id = coa.id
         where coa.is_active = true
         group by coa.account_code`,
        [fromDate],
      ),
      query(
        `select coa.account_code, m.entry_date, m.je_no, m.narration, m.debit, m.credit, m.je_id, m.line_no
         from chart_of_accounts coa
         join (
           select jel.account_id, je.entry_date, je.id as je_id, je.je_no, jel.narration, jel.debit, jel.credit, jel.line_no
           from journal_entry_lines jel
           join journal_entries je on je.id = jel.journal_entry_id
           where je.status = 'posted' and je.entry_date between $1 and $2
         ) m on m.account_id = coa.id
         where coa.is_active = true
         order by coa.account_code, m.entry_date, m.je_id, m.line_no`,
        [fromDate, toDate],
      ),
      query(
        `select c.id as party_id, coalesce(sum(m.debit - m.credit), 0) as opening_balance
         from customers c
         left join (
           select jel.party_id, jel.debit, jel.credit
           from journal_entry_lines jel
           join journal_entries je on je.id = jel.journal_entry_id
           where je.status = 'posted' and je.entry_date < $1 and jel.party_type = 'customer'
         ) m on m.party_id = c.id
         where c.is_active = true
         group by c.id`,
        [fromDate],
      ),
      query(
        `select c.id as party_id, m.entry_date, m.je_no, m.source_type, m.narration, m.debit, m.credit, m.je_id, m.line_no
         from customers c
         join (
           select jel.party_id, je.entry_date, je.id as je_id, je.je_no, je.source_type, jel.narration, jel.debit, jel.credit, jel.line_no
           from journal_entry_lines jel
           join journal_entries je on je.id = jel.journal_entry_id
           where je.status = 'posted' and je.entry_date between $1 and $2 and jel.party_type = 'customer'
         ) m on m.party_id = c.id
         where c.is_active = true
         order by c.id, m.entry_date, m.je_id, m.line_no`,
        [fromDate, toDate],
      ),
      query(
        `select v.id as party_id, coalesce(sum(m.debit - m.credit), 0) as opening_balance
         from vendors v
         left join (
           select jel.party_id, jel.debit, jel.credit
           from journal_entry_lines jel
           join journal_entries je on je.id = jel.journal_entry_id
           where je.status = 'posted' and je.entry_date < $1 and jel.party_type = 'vendor'
         ) m on m.party_id = v.id
         where v.is_active = true
         group by v.id`,
        [fromDate],
      ),
      query(
        `select v.id as party_id, m.entry_date, m.je_no, m.source_type, m.narration, m.debit, m.credit, m.je_id, m.line_no
         from vendors v
         join (
           select jel.party_id, je.entry_date, je.id as je_id, je.je_no, je.source_type, jel.narration, jel.debit, jel.credit, jel.line_no
           from journal_entry_lines jel
           join journal_entries je on je.id = jel.journal_entry_id
           where je.status = 'posted' and je.entry_date between $1 and $2 and jel.party_type = 'vendor'
         ) m on m.party_id = v.id
         where v.is_active = true
         order by v.id, m.entry_date, m.je_id, m.line_no`,
        [fromDate, toDate],
      ),
    ]);

  // Shared helper: seed each group's running balance from its own
  // opening balance, then walk its (already date/id/line-ordered)
  // movement rows once, adding a running_balance field exactly like
  // generalLedger()'s SQL window function did per-account before.
  function assemble(
    keyField: "account_code" | "party_id",
    openingRows: Array<Record<string, unknown>>,
    movementRows: Array<Record<string, unknown>>,
  ) {
    const result: Record<string | number, { openingBalance: number; movements: unknown[]; closingBalance: number }> = {};
    for (const o of openingRows) {
      const key = o[keyField] as string | number;
      result[key] = { openingBalance: Number(o.opening_balance), movements: [], closingBalance: Number(o.opening_balance) };
    }
    for (const m of movementRows) {
      const key = m[keyField] as string | number;
      const entry = result[key];
      if (!entry) continue; // shouldn't happen — every movement's account/party is also in the opening set
      const running = entry.closingBalance + (Number(m.debit) - Number(m.credit));
      entry.movements.push({ ...m, running_balance: running });
      entry.closingBalance = running;
    }
    return result;
  }

  return {
    byAccountCode: assemble("account_code", openingByCoa.rows, movementsByCoa.rows),
    byCustomerId: assemble("party_id", openingByCustomer.rows, movementsByCustomer.rows),
    byVendorId: assemble("party_id", openingByVendor.rows, movementsByVendor.rows),
  };
}

export async function trialBalance(asOfDate: string) {
  // FIX (SAT defect #1): the status/date filter was previously attached
  // to the ON clause of the journal_entries join, which only affects
  // whether je.* columns are null — it does NOT restrict which
  // journal_entry_lines rows get summed, since jel is joined to coa
  // unconditionally on account_id alone. Proven live: asOfDate had zero
  // effect on the totals regardless of value, including dates before
  // any data existed. Fix: pre-filter jel/je together in a subquery
  // (inner join, so the status/date condition actually restricts which
  // lines are summed) before left-joining the filtered result to
  // chart_of_accounts.
  const { rows } = await query(
    `select
       coa.account_code,
       coa.account_name,
       coa.account_type,
       coalesce(sum(jel.debit), 0)  as total_debit,
       coalesce(sum(jel.credit), 0) as total_credit,
       coalesce(sum(jel.debit), 0) - coalesce(sum(jel.credit), 0) as balance
     from chart_of_accounts coa
     left join (
       select jel.account_id, jel.debit, jel.credit
       from journal_entry_lines jel
       join journal_entries je on je.id = jel.journal_entry_id
       where je.status = 'posted'
         and je.entry_date <= $1
     ) jel on jel.account_id = coa.id
     where coa.is_active = true
     group by coa.id, coa.account_code, coa.account_name, coa.account_type
     having coalesce(sum(jel.debit), 0) != 0 or coalesce(sum(jel.credit), 0) != 0
     order by coa.account_code`,
    [asOfDate],
  );

  const debitTotal = rows.reduce((s, r) => s + Math.max(Number(r.balance), 0), 0);
  const creditTotal = rows.reduce((s, r) => s + Math.max(-Number(r.balance), 0), 0);

  return { rows, debitTotal, creditTotal, balanced: Math.round(debitTotal * 100) === Math.round(creditTotal * 100) };
}

export async function profitAndLoss(fromDate: string, toDate: string) {
  const { rows } = await query(
    `select
       coa.account_code,
       coa.account_name,
       coa.account_type,
       coalesce(sum(jel.credit), 0) - coalesce(sum(jel.debit), 0) as net_income_amount,
       coalesce(sum(jel.debit), 0) - coalesce(sum(jel.credit), 0) as net_expense_amount
     from chart_of_accounts coa
     join journal_entry_lines jel on jel.account_id = coa.id
     join journal_entries je on je.id = jel.journal_entry_id
     where je.status = 'posted'
       and je.entry_date between $1 and $2
       and coa.account_type in ('income', 'expense')
     group by coa.id, coa.account_code, coa.account_name, coa.account_type
     order by coa.account_type, coa.account_code`,
    [fromDate, toDate],
  );

  const income = rows.filter((r) => r.account_type === "income");
  const expense = rows.filter((r) => r.account_type === "expense");
  const totalIncome = income.reduce((s, r) => s + Number(r.net_income_amount), 0);
  const totalExpense = expense.reduce((s, r) => s + Number(r.net_expense_amount), 0);

  return {
    income,
    expense,
    totalIncome,
    totalExpense,
    profitOrLoss: totalIncome - totalExpense,
  };
}

export async function balanceSheet(asOfDate: string) {
  // FIX (SAT defect #1): same root cause and same fix pattern as
  // trialBalance() above — pre-filter jel/je in a subquery so the
  // status/date condition actually restricts the summed lines, instead
  // of sitting inertly on the ON clause of the je join. This is also
  // what caused "balanced: false" for any asOfDate other than today:
  // this asset/liability query was date-blind while the embedded
  // profitAndLoss() call below was correctly date-bound, so the two
  // halves silently diverged whenever entry_date > asOfDate existed.
  const { rows } = await query(
    `select
       coa.account_code,
       coa.account_name,
       coa.account_type,
       coalesce(sum(jel.debit), 0) - coalesce(sum(jel.credit), 0) as balance
     from chart_of_accounts coa
     left join (
       select jel.account_id, jel.debit, jel.credit
       from journal_entry_lines jel
       join journal_entries je on je.id = jel.journal_entry_id
       where je.status = 'posted'
         and je.entry_date <= $1
     ) jel on jel.account_id = coa.id
     where coa.is_active = true
       and coa.account_type in ('asset', 'liability', 'equity')
     group by coa.id, coa.account_code, coa.account_name, coa.account_type
     having coalesce(sum(jel.debit), 0) != 0 or coalesce(sum(jel.credit), 0) != 0
     order by coa.account_type, coa.account_code`,
    [asOfDate],
  );

  // Retained profit/loss for the year-to-date folds into equity so the
  // sheet balances without a separate manual closing entry.
  //
  // FIX (found during hardening review): this previously assumed the
  // financial year starts on April 1 of asOfDate's own calendar year
  // — `${asOfDate.slice(0,4)}-04-01`. That's wrong for any asOfDate
  // that falls before the FY's April rollover (e.g. asOfDate in
  // Jan/Feb/Mar, which is most of a year-end report): for FY 2026-27
  // (Apr 2026 - Mar 2027) and asOfDate = 2027-03-31, it computed a
  // range of 2027-04-01..2027-03-31 — fromDate AFTER toDate, silently
  // returning zero profit and dropping real P&L out of equity
  // entirely. Confirmed live: caused totalAssets=400 vs
  // totalLiabilities+totalEquity=100, a 300 mismatch, exactly the
  // year-end reversal profit that went missing.
  //
  // Fixed to look up the real financial_years row containing
  // asOfDate — the same source of truth requireOpenFinancialYear()
  // uses for postings — instead of assuming a calendar convention.
  const { rows: fyRows } = await query(
    `select start_date from financial_years where $1::date between start_date and end_date`,
    [asOfDate],
  );
  const pnlFromDate = fyRows[0]
    ? fyRows[0].start_date.toISOString().slice(0, 10)
    : `${asOfDate.slice(0, 4)}-01-01`; // no FY row covers this date — fall back to calendar year rather than throwing, since a balance sheet should still render for an out-of-FY-range date
  const pnl = await profitAndLoss(pnlFromDate, asOfDate);

  const assets = rows.filter((r) => r.account_type === "asset");
  const liabilities = rows.filter((r) => r.account_type === "liability");
  const equity = rows.filter((r) => r.account_type === "equity");

  const totalAssets = assets.reduce((s, r) => s + Number(r.balance), 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + -Number(r.balance), 0);
  const totalEquity = equity.reduce((s, r) => s + -Number(r.balance), 0) + pnl.profitOrLoss;

  return {
    assets,
    liabilities,
    equity,
    currentPeriodProfit: pnl.profitOrLoss,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: Math.round(totalAssets * 100) === Math.round((totalLiabilities + totalEquity) * 100),
  };
}

// ============================================================
// PHASE 2 REPORTS
// All additive — nothing above this line was changed for Phase 2.
// Same rule as everything above: read-only, derived live from
// posted journal_entry_lines only, nothing stored.
// ============================================================

/**
 * Customer or vendor ledger: every posted journal line tagged with
 * this party (party_type + party_id), regardless of which account
 * it hit — not just the control account (Trade Debtors/Creditors).
 * Same opening-balance-carries-forward fix as generalLedger() above.
 */
export async function partyLedger(partyType: "customer" | "vendor", partyId: number, fromDate: string, toDate: string) {
  const { rows: openingRows } = await query(
    `select coalesce(sum(jel.debit - jel.credit), 0) as opening_balance
     from journal_entry_lines jel
     join journal_entries je on je.id = jel.journal_entry_id
     where jel.party_type = $1 and jel.party_id = $2
       and je.status = 'posted'
       and je.entry_date < $3`,
    [partyType, partyId, fromDate],
  );
  const openingBalance = Number(openingRows[0].opening_balance);

  const { rows } = await query(
    `select
       je.entry_date, je.je_no, je.source_type, jel.narration, jel.debit, jel.credit,
       $5::numeric + sum(jel.debit - jel.credit) over (order by je.entry_date, je.id, jel.line_no) as running_balance
     from journal_entry_lines jel
     join journal_entries je on je.id = jel.journal_entry_id
     where jel.party_type = $1 and jel.party_id = $2
       and je.status = 'posted'
       and je.entry_date between $3 and $4
     order by je.entry_date, je.id, jel.line_no`,
    [partyType, partyId, fromDate, toDate, openingBalance],
  );

  return {
    openingBalance,
    movements: rows,
    closingBalance: rows.length > 0 ? Number(rows[rows.length - 1].running_balance) : openingBalance,
  };
}

/** Every customer's current outstanding, in one query — not per-customer looped calls. */
export async function customerOutstanding() {
  // FIX (SAT defect #1 review — same pattern found elsewhere): the
  // status filter was on the ON clause of the journal_entries join,
  // same inert-filter bug as trialBalance()/balanceSheet(). Currently
  // harmless in practice (no code path ever sets journal_entries.status
  // to anything but 'posted'), but fixed for correctness and to remove
  // the latent risk rather than leave a proven bug pattern in place
  // elsewhere in the same file.
  const { rows } = await query(
    `select
       c.id as customer_id, c.customer_name,
       coalesce(sum(jel.debit - jel.credit), 0) as outstanding
     from customers c
     left join (
       select jel.party_id, jel.debit, jel.credit
       from journal_entry_lines jel
       join journal_entries je on je.id = jel.journal_entry_id
       where jel.party_type = 'customer' and je.status = 'posted'
     ) jel on jel.party_id = c.id
     where c.is_active = true
     group by c.id, c.customer_name
     having coalesce(sum(jel.debit - jel.credit), 0) != 0
     order by c.customer_name`,
  );
  return rows;
}

/** Every vendor's current outstanding. Creditor balances are credit-positive, so this is (credit - debit). */
export async function vendorOutstanding() {
  // FIX: same pattern and same rationale as customerOutstanding() above.
  const { rows } = await query(
    `select
       v.id as vendor_id, v.vendor_name,
       coalesce(sum(jel.credit - jel.debit), 0) as outstanding
     from vendors v
     left join (
       select jel.party_id, jel.debit, jel.credit
       from journal_entry_lines jel
       join journal_entries je on je.id = jel.journal_entry_id
       where jel.party_type = 'vendor' and je.status = 'posted'
     ) jel on jel.party_id = v.id
     where v.is_active = true
     group by v.id, v.vendor_name
     having coalesce(sum(jel.credit - jel.debit), 0) != 0
     order by v.vendor_name`,
  );
  return rows;
}

/** Day book: every posted transaction in date order, header-level — the chronological record the philosophy calls for. */
export async function dayBook(fromDate: string, toDate: string) {
  const { rows } = await query(
    `select je.id, je.je_no, je.entry_date, je.narration, je.source_type,
       coalesce(sum(jel.debit), 0) as total_amount
     from journal_entries je
     join journal_entry_lines jel on jel.journal_entry_id = je.id
     where je.status = 'posted'
       and je.entry_date between $1 and $2
     group by je.id, je.je_no, je.entry_date, je.narration, je.source_type
     order by je.entry_date, je.id`,
    [fromDate, toDate],
  );
  return rows;
}

/**
 * GST report: output tax collected vs input tax paid for a period,
 * net payable. Reads directly from the GST accounts' posted
 * movement — no separate GST ledger is maintained, per "reports
 * are always derived, never stored".
 */
export async function gstReport(fromDate: string, toDate: string) {
  const { rows } = await query(
    `select coa.account_code, coa.account_name,
       coalesce(sum(jel.debit), 0) as total_debit,
       coalesce(sum(jel.credit), 0) as total_credit
     from chart_of_accounts coa
     join journal_entry_lines jel on jel.account_id = coa.id
     join journal_entries je on je.id = jel.journal_entry_id
     where je.status = 'posted'
       and je.entry_date between $1 and $2
       and coa.account_code in ('2151','2152','2153','1161','1162','1163')
     group by coa.account_code, coa.account_name
     order by coa.account_code`,
    [fromDate, toDate],
  );

  const output = rows.filter((r) => r.account_code.startsWith("215"));
  const input = rows.filter((r) => r.account_code.startsWith("116"));
  // Net both sides of each account — a credit note, debit note, or
  // reversal posts to the opposite side of these same accounts, and
  // must reduce the reported total. Summing only total_credit (output)
  // or only total_debit (input) ignored those reductions entirely.
  // Confirmed live via the regression suite: a credit note against an
  // interstate invoice left totalOutput overstated by exactly the
  // reversed IGST amount.
  const totalOutput = output.reduce((s, r) => s + (Number(r.total_credit) - Number(r.total_debit)), 0);
  const totalInput = input.reduce((s, r) => s + (Number(r.total_debit) - Number(r.total_credit)), 0);

  return {
    output,
    input,
    totalOutput,
    totalInput,
    netPayable: totalOutput - totalInput,
  };
}
