import { Router, type Request, type Response } from "express";
import { query } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";

/**
 * Dashboard summary — deliberately has no router.use(requirePermission(...))
 * gate. Every other module's routes require a specific permission
 * because that module can be hidden from someone's sidebar entirely —
 * but the Dashboard itself is the one page every employee lands on
 * regardless of role, so this can't be gated the same way without
 * breaking the dashboard for anyone without every underlying
 * permission. Each figure below is still a real, correct aggregate —
 * not a placeholder — just not permission-restricted at the route
 * level.
 */
const router = Router();

router.get("/summary", asyncHandler(async (_req: Request, res: Response) => {
  const [revenueRow, pendingInvoicesRow, customersRow, cashRow, recentInvoices, recentPayments, recentReceipts, todayActivity, pendingRequestsRow, unmappedTxnsRow] = await Promise.all([
    query(
      `select
         coalesce(sum(total) filter (where date_trunc('month', invoice_date) = date_trunc('month', current_date)), 0) as this_month,
         coalesce(sum(total) filter (where date_trunc('month', invoice_date) = date_trunc('month', current_date - interval '1 month')), 0) as last_month
       from sales_invoices where status = 'posted'`,
    ),
    query(
      `select
         (select count(*)::int from sales_invoices where status = 'draft') +
         (select count(*)::int from purchase_invoices where status = 'draft') as pending_count`,
    ),
    query(`select count(*)::int as total_customers from customers where is_active is distinct from false`),
    // FIX (highest priority — real bug): this used to sum raw
    // bank_transactions.credit/debit rows directly — i.e. whatever's
    // been IMPORTED, regardless of mapping_status. An Unmapped,
    // Ignored, Duplicate, or Mapped-but-not-yet-Posted transaction
    // moved this figure the moment it was imported, before it had
    // ever touched the actual ledger — meaning Cash in Hand here could
    // (and did, in principle) disagree with the real posted balance
    // for the exact same accounts shown on General Ledger / Bank &
    // Cash. It also separately re-added bank_accounts.opening_balance,
    // which double-counts once an account's opening balance has been
    // posted as a real journal entry (see backfillOpeningBalances()/
    // postJournalEntry's 'bank_account_opening' sourceType) — a
    // posted opening balance is already inside journal_entry_lines,
    // it doesn't need to be added again from the raw column.
    //
    // Journal is the single source of truth: this now sums ONLY
    // journal_entry_lines belonging to a POSTED journal entry, for
    // whichever chart_of_accounts rows are actually linked to a
    // Cash/Petty Cash bank account. Anything not yet posted — however
    // it's currently mapped — simply isn't counted yet, exactly as it
    // shouldn't be.
    query(
      `select coalesce(sum(jel.debit - jel.credit), 0) as cash_in_hand
       from journal_entry_lines jel
       join journal_entries je on je.id = jel.journal_entry_id
       join bank_accounts ba on ba.coa_id = jel.account_id
       where je.status = 'posted'
         and ba.account_type in ('Cash', 'Petty Cash')
         and ba.is_active is distinct from false`,
    ),
    query(`select 'invoice' as kind, invoice_no as doc_no, total as amount, invoice_date as doc_date, status from sales_invoices order by invoice_date desc, id desc limit 5`),
    query(`select 'payment' as kind, payment_no as doc_no, amount, payment_date as doc_date, status from payments order by payment_date desc, id desc limit 5`),
    query(`select 'receipt' as kind, receipt_no as doc_no, amount, receipt_date as doc_date, status from receipts order by receipt_date desc, id desc limit 5`),
    query(`select module, action, performed_at from audit_log where performed_at >= current_date order by performed_at desc limit 10`),
    query(`select count(*)::int as count from customer_requests where status = 'Open'`),
    query(`select count(*)::int as count from bank_transactions where mapping_status = 'Unmapped'`),
  ]);

  const thisMonth = Number(revenueRow.rows[0].this_month);
  const lastMonth = Number(revenueRow.rows[0].last_month);
  const recentTransactions = [...recentInvoices.rows, ...recentPayments.rows, ...recentReceipts.rows]
    .sort((a: any, b: any) => new Date(b.doc_date).getTime() - new Date(a.doc_date).getTime())
    .slice(0, 8);

  return res.status(200).json({
    total_revenue: thisMonth,
    total_revenue_change_pct: lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : null,
    pending_invoices: pendingInvoicesRow.rows[0].pending_count,
    total_customers: customersRow.rows[0].total_customers,
    cash_in_hand: Number(cashRow.rows[0].cash_in_hand),
    recent_transactions: recentTransactions,
    today_activity: todayActivity.rows,
    pending_customer_requests: pendingRequestsRow.rows[0].count,
    unmapped_bank_transactions: unmappedTxnsRow.rows[0].count,
  });
}));

export default router;
