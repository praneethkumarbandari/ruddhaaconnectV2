import { pool, query } from "../db/pool.ts";

/**
 * Project Reporting Service.
 *
 * Every function here is read-only. None writes to journal_entries,
 * journal_entry_lines, or any Project Management table. This file has
 * no INSERT/UPDATE/DELETE statement anywhere in it — a structural fact,
 * not a promise, and checkable by grep.
 *
 * Budget is the one value that originates in Project Management
 * (project_budget, an approved version's lines). Every other number —
 * actual cost, revenue, cash, outstanding — is queried live from
 * Accounting's existing tables, joined by project_id. Profit is pure
 * arithmetic over those derived numbers, computed here, stored nowhere.
 */

async function approvedBudgetTotal(projectId: number, budgetType: "cost" | "revenue"): Promise<number> {
  const { rows } = await query(
    `select coalesce(sum(pb.budgeted_amount), 0) as total
     from project_budget pb
     join project_budget_versions pbv on pbv.id = pb.budget_version_id
     where pbv.project_id = $1 and pbv.status = 'approved' and pb.budget_type = $2`,
    [projectId, budgetType],
  );
  return Number(rows[0].total);
}

/** Revenue = posted Sales Invoices tagged to the project, minus posted Credit Notes tagged to it. */
export async function projectRevenue(projectId: number, fromDate?: string, toDate?: string) {
  const params: unknown[] = [projectId];
  let dateClause = "";
  if (fromDate) { params.push(fromDate); dateClause += ` and je.entry_date >= $${params.length}`; }
  if (toDate) { params.push(toDate); dateClause += ` and je.entry_date <= $${params.length}`; }

  const { rows: invRows } = await query(
    `select coalesce(sum(si.total), 0) as total
     from sales_invoices si
     join journal_entries je on je.source_type = 'invoice' and je.source_id = si.id
     where si.project_id = $1 and si.status = 'posted' and je.status = 'posted' ${dateClause}`,
    params,
  );
  const { rows: cnRows } = await query(
    `select coalesce(sum(cn.total), 0) as total
     from credit_notes cn
     join journal_entries je on je.source_type = 'credit_note' and je.source_id = cn.id
     where cn.project_id = $1 and cn.status = 'posted' and je.status = 'posted' ${dateClause}`,
    params,
  );
  const gross = Number(invRows[0].total);
  const reductions = Number(cnRows[0].total);
  return { grossRevenue: gross, creditNotes: reductions, netRevenue: gross - reductions };
}

/** Cost = posted Purchase Invoices tagged to the project, minus posted Debit Notes tagged to it. */
export async function projectCost(projectId: number, fromDate?: string, toDate?: string) {
  const params: unknown[] = [projectId];
  let dateClause = "";
  if (fromDate) { params.push(fromDate); dateClause += ` and je.entry_date >= $${params.length}`; }
  if (toDate) { params.push(toDate); dateClause += ` and je.entry_date <= $${params.length}`; }

  const { rows: purRows } = await query(
    `select coalesce(sum(pi.total), 0) as total
     from purchase_invoices pi
     join journal_entries je on je.source_type = 'purchase' and je.source_id = pi.id
     where pi.project_id = $1 and pi.status = 'posted' and je.status = 'posted' ${dateClause}`,
    params,
  );
  const { rows: dnRows } = await query(
    `select coalesce(sum(dn.total), 0) as total
     from debit_notes dn
     join journal_entries je on je.source_type = 'debit_note' and je.source_id = dn.id
     where dn.project_id = $1 and dn.status = 'posted' and je.status = 'posted' ${dateClause}`,
    params,
  );
  const gross = Number(purRows[0].total);
  const reductions = Number(dnRows[0].total);
  return { grossCost: gross, debitNotes: reductions, netCost: gross - reductions };
}

/**
 * Manual/Contra Journal Entries tagged directly to the project (no
 * document table — see Phase 3's implementation strategy). Only
 * income/expense account lines count toward P&L impact — a line
 * hitting a balance-sheet account (e.g. Cash) within the same entry
 * must NOT be counted, exactly matching reports.ts's profitAndLoss()
 * filter (`coa.account_type in ('income','expense')`). Summing every
 * line of the entry indiscriminately would silently include the
 * cash/liability side of the same journal entry as if it were a
 * profit-and-loss movement — caught by checking against the existing
 * function's pattern before this was ever run, not after.
 */
export async function projectManualJournalNet(projectId: number, fromDate?: string, toDate?: string) {
  const params: unknown[] = [projectId];
  let dateClause = "";
  if (fromDate) { params.push(fromDate); dateClause += ` and je.entry_date >= $${params.length}`; }
  if (toDate) { params.push(toDate); dateClause += ` and je.entry_date <= $${params.length}`; }

  const { rows } = await query(
    `select coalesce(sum(jel.credit - jel.debit), 0) as net
     from journal_entries je
     join journal_entry_lines jel on jel.journal_entry_id = je.id
     join chart_of_accounts coa on coa.id = jel.account_id
     where je.project_id = $1 and je.status = 'posted' and je.source_type in ('manual', 'contra', 'reversal')
       and coa.account_type in ('income', 'expense')
       ${dateClause}`,
    params,
  );
  return Number(rows[0].net);
}

/** Cash Flow = posted Receipts (in) and Payments (out) tagged to the project. */
export async function projectCashFlow(projectId: number, fromDate?: string, toDate?: string) {
  const params: unknown[] = [projectId];
  let dateClause = "";
  if (fromDate) { params.push(fromDate); dateClause += ` and je.entry_date >= $${params.length}`; }
  if (toDate) { params.push(toDate); dateClause += ` and je.entry_date <= $${params.length}`; }

  const { rows: rcptRows } = await query(
    `select coalesce(sum(r.amount), 0) as total
     from receipts r
     join journal_entries je on je.source_type = 'receipt' and je.source_id = r.id
     where r.project_id = $1 and r.status = 'posted' and je.status = 'posted' ${dateClause}`,
    params,
  );
  const { rows: pmtRows } = await query(
    `select coalesce(sum(p.amount), 0) as total
     from payments p
     join journal_entries je on je.source_type = 'payment' and je.source_id = p.id
     where p.project_id = $1 and p.status = 'posted' and je.status = 'posted' ${dateClause}`,
    params,
  );
  const cashIn = Number(rcptRows[0].total);
  const cashOut = Number(pmtRows[0].total);
  return { cashIn, cashOut, netCash: cashIn - cashOut };
}

/** Outstanding — reuses the exact existing customerOutstanding()/vendorOutstanding() shape from reports.ts, scoped by project. */
/**
 * Outstanding — reuses the exact debit-minus-credit party-ledger shape
 * already established in reports.ts's customerOutstanding()/
 * vendorOutstanding(), scoped to this project. journal_entries.project_id
 * is null for these six document types by design (Phase 2) — the tag
 * lives on the document itself, so scoping happens via a subquery
 * against sales_invoices/receipts/credit_notes (receivable side) and
 * purchase_invoices/payments/debit_notes (payable side), not via a
 * column on journal_entries.
 */
export async function projectOutstanding(projectId: number) {
  const { rows: receivableRows } = await query(
    `select coalesce(sum(jel.debit - jel.credit), 0) as outstanding
     from journal_entry_lines jel
     join journal_entries je on je.id = jel.journal_entry_id
     where je.status = 'posted'
       and jel.party_type = 'customer'
       and (
         (je.source_type = 'invoice' and je.source_id in (select id from sales_invoices where project_id = $1 and status = 'posted'))
         or (je.source_type = 'receipt' and je.source_id in (select id from receipts where project_id = $1 and status = 'posted'))
         or (je.source_type = 'credit_note' and je.source_id in (select id from credit_notes where project_id = $1 and status = 'posted'))
       )`,
    [projectId],
  );
  const { rows: payableRows } = await query(
    `select coalesce(sum(jel.credit - jel.debit), 0) as outstanding
     from journal_entry_lines jel
     join journal_entries je on je.id = jel.journal_entry_id
     where je.status = 'posted'
       and jel.party_type = 'vendor'
       and (
         (je.source_type = 'purchase' and je.source_id in (select id from purchase_invoices where project_id = $1 and status = 'posted'))
         or (je.source_type = 'payment' and je.source_id in (select id from payments where project_id = $1 and status = 'posted'))
         or (je.source_type = 'debit_note' and je.source_id in (select id from debit_notes where project_id = $1 and status = 'posted'))
       )`,
    [projectId],
  );
  return {
    receivable: Number(receivableRows[0].outstanding),
    payable: Number(payableRows[0].outstanding),
  };
}

/** Budget vs Actual — the only place Project Management's own number (budget) and Accounting's derived number (actual) sit side by side. */
export async function budgetVsActual(projectId: number) {
  const budgetedCost = await approvedBudgetTotal(projectId, "cost");
  const budgetedRevenue = await approvedBudgetTotal(projectId, "revenue");
  const { netCost } = await projectCost(projectId);
  const { netRevenue } = await projectRevenue(projectId);
  return {
    cost: { budgeted: budgetedCost, actual: netCost, variance: budgetedCost - netCost },
    revenue: { budgeted: budgetedRevenue, actual: netRevenue, variance: netRevenue - budgetedRevenue },
  };
}

/** Profitability — pure arithmetic over the derived figures above. Nothing here is stored. */
export async function projectProfitability(projectId: number, fromDate?: string, toDate?: string) {
  const { netRevenue } = await projectRevenue(projectId, fromDate, toDate);
  const { netCost } = await projectCost(projectId, fromDate, toDate);
  const manualNet = await projectManualJournalNet(projectId, fromDate, toDate);
  const grossProfit = netRevenue - netCost;
  const netProfit = grossProfit + manualNet;
  return { netRevenue, netCost, grossProfit, manualJournalNet: manualNet, netProfit };
}

/**
 * Financial Timeline — every posted transaction tagged to this
 * project, in date order. Same shape as reports.ts's dayBook(), scoped
 * by project across all eight possible tag points (the six document
 * tables plus journal_entries.project_id directly for manual/contra).
 */
export async function projectFinancialTimeline(projectId: number, fromDate?: string, toDate?: string) {
  const params: unknown[] = [projectId];
  let dateClause = "";
  if (fromDate) { params.push(fromDate); dateClause += ` and je.entry_date >= $${params.length}`; }
  if (toDate) { params.push(toDate); dateClause += ` and je.entry_date <= $${params.length}`; }

  const { rows } = await query(
    `select je.id, je.je_no, je.entry_date, je.narration, je.source_type,
       coalesce(sum(jel.debit), 0) as total_amount
     from journal_entries je
     join journal_entry_lines jel on jel.journal_entry_id = je.id
     where je.status = 'posted' ${dateClause}
       and (
         je.project_id = $1
         or (je.source_type = 'invoice' and je.source_id in (select id from sales_invoices where project_id = $1))
         or (je.source_type = 'purchase' and je.source_id in (select id from purchase_invoices where project_id = $1))
         or (je.source_type = 'receipt' and je.source_id in (select id from receipts where project_id = $1))
         or (je.source_type = 'payment' and je.source_id in (select id from payments where project_id = $1))
         or (je.source_type = 'credit_note' and je.source_id in (select id from credit_notes where project_id = $1))
         or (je.source_type = 'debit_note' and je.source_id in (select id from debit_notes where project_id = $1))
       )
     group by je.id, je.je_no, je.entry_date, je.narration, je.source_type
     order by je.entry_date, je.id`,
    params,
  );
  return rows;
}

/** Composite dashboard — assembles the functions above, computes nothing new of its own. */
export async function projectDashboard(projectId: number) {
  const [budgetVsActualResult, profitability, cashFlow, outstanding] = await Promise.all([
    budgetVsActual(projectId),
    projectProfitability(projectId),
    projectCashFlow(projectId),
    projectOutstanding(projectId),
  ]);
  return { budgetVsActual: budgetVsActualResult, profitability, cashFlow, outstanding };
}
