import { Router, type Request, type Response } from "express";
import { query } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";

const router = Router();

/**
 * Universal Search: one endpoint, one query string, results across
 * every major master and transaction type — Customers, Vendors,
 * Ledgers (chart_of_accounts), Bank Accounts, Bank Transactions,
 * Invoices (sales + purchase), Journal Entries, Inventory, Projects,
 * Employees — plus a small static list of report/settings pages,
 * matched client-side since those aren't database records.
 *
 * Deliberately gated only by the blanket requireAuth already applied
 * to all of /api (see app.ts) — not a per-module permission — since a
 * search bar that silently omits results a logged-in employee can't
 * otherwise see would be confusing ("why didn't my search find
 * this?") rather than a real access-control boundary; every list this
 * pulls from is read-only, and the actual record/page a result links
 * to still enforces its own real permission when opened.
 *
 * Each category runs as its own small, LIMIT-capped query rather than
 * one giant UNION — the columns are wildly different per type (an
 * invoice's "amount" has no equivalent on an employee row), so forcing
 * them into one SQL shape would need lossy casting; five small
 * targeted queries in parallel is both simpler and easier to reason
 * about than one clever one.
 */
router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.status(200).json([]);
  const like = `%${q}%`;

  const [
    customers, vendors, ledgers, bankAccounts, bankTransactions,
    salesInvoices, purchaseInvoices, journalEntries, inventory, projects, employees,
  ] = await Promise.all([
    query(
      `select id, customer_name from customers where is_active = true and customer_name ilike $1 order by customer_name limit 5`,
      [like],
    ),
    query(
      `select id, vendor_name from vendors where is_active = true and vendor_name ilike $1 order by vendor_name limit 5`,
      [like],
    ),
    query(
      `select account_code, account_name from chart_of_accounts where is_active = true and (account_name ilike $1 or account_code ilike $1) order by account_code limit 5`,
      [like],
    ),
    query(
      `select id, account_name, bank_name from bank_accounts where is_active is distinct from false and (account_name ilike $1 or bank_name ilike $1) order by account_name limit 5`,
      [like],
    ),
    query(
      `select id, bank_account_id, description, transaction_date from bank_transactions where description ilike $1 order by transaction_date desc limit 5`,
      [like],
    ),
    query(
      `select si.id, si.invoice_no, c.customer_name from sales_invoices si join customers c on c.id = si.customer_id
       where si.invoice_no ilike $1 or c.customer_name ilike $1 order by si.invoice_date desc limit 5`,
      [like],
    ),
    query(
      `select pi.id, pi.purchase_no, v.vendor_name from purchase_invoices pi join vendors v on v.id = pi.vendor_id
       where pi.purchase_no ilike $1 or v.vendor_name ilike $1 order by pi.invoice_date desc limit 5`,
      [like],
    ),
    query(
      `select id, je_no, narration from journal_entries where je_no ilike $1 or narration ilike $1 order by entry_date desc limit 5`,
      [like],
    ),
    query(
      `select id, code, name from inventory where name ilike $1 or code ilike $1 order by name limit 5`,
      [like],
    ),
    query(
      `select id, project_code, project_name from projects where project_name ilike $1 or project_code ilike $1 order by project_name limit 5`,
      [like],
    ),
    query(
      `select id, employee_name, username from employees where is_active = true and (employee_name ilike $1 or username ilike $1) order by employee_name limit 5`,
      [like],
    ),
  ]);

  const results: Array<{ type: string; label: string; sublabel?: string; url: string }> = [];
  for (const c of customers.rows) results.push({ type: "Customer", label: c.customer_name, url: "/customers.html" });
  for (const v of vendors.rows) results.push({ type: "Vendor", label: v.vendor_name, url: "/vendors.html" });
  for (const l of ledgers.rows) results.push({ type: "Ledger", label: `${l.account_name} (${l.account_code})`, url: "/general-ledger.html" });
  for (const b of bankAccounts.rows) results.push({ type: "Bank Account", label: b.account_name, sublabel: b.bank_name || undefined, url: "/bank-transactions.html" });
  for (const t of bankTransactions.rows) results.push({ type: "Bank Transaction", label: t.description || "(no description)", sublabel: new Date(t.transaction_date).toLocaleDateString("en-IN"), url: "/bank-transactions.html" });
  for (const s of salesInvoices.rows) results.push({ type: "Sales Invoice", label: s.invoice_no || "(draft)", sublabel: s.customer_name, url: "/invoices.html" });
  for (const p of purchaseInvoices.rows) results.push({ type: "Purchase Invoice", label: p.purchase_no || "(draft)", sublabel: p.vendor_name, url: "/invoices.html" });
  for (const j of journalEntries.rows) results.push({ type: "Journal Entry", label: j.je_no, sublabel: j.narration || undefined, url: "/journal-entries.html" });
  for (const i of inventory.rows) results.push({ type: "Inventory Item", label: i.name, sublabel: i.code, url: "/inventory.html" });
  for (const p of projects.rows) results.push({ type: "Project", label: p.project_name, sublabel: p.project_code, url: "/pm-projects.html" });
  for (const e of employees.rows) results.push({ type: "Employee", label: e.employee_name, sublabel: e.username, url: "/employees.html" });

  return res.status(200).json(results);
}));

export default router;
