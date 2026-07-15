import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requireCustomerAuth } from "../middleware/customer-auth.ts";
import { customerTenantContextMiddleware } from "../middleware/customer-tenant-context.ts";
import { partyLedger } from "../lib/reports.ts";
import { writeAudit } from "../lib/audit.ts";

/**
 * FIX (production-readiness follow-up): my-payments.html and
 * my-profile.html's "request" flow previously read/wrote Supabase
 * directly — my-payments.html against a `transactions` table that
 * doesn't correspond to any table this backend's migrations create,
 * and my-profile.html's insert into `customer_requests` used columns
 * (`request_type`) that don't exist on the real table, meaning every
 * submission failed with a Postgres "column does not exist" error.
 *
 * Every route here is scoped to the AUTHENTICATED customer only, via
 * req.customer!.customerId from requireCustomerAuth — never a
 * client-supplied id — so a customer can only ever see or create
 * their own data, the same ownership pattern used everywhere else in
 * this codebase (attendance /my, leave cancellation, payslip access).
 *
 * my-documents.html is NOT covered here: it reads from a `documents`
 * table that has never existed in this backend's schema at all (only
 * employee_documents and project_documents exist, neither customer-
 * facing). That's a genuine missing feature — real customer document
 * storage needs actual file storage (S3/Supabase Storage or similar),
 * not just an API route — not something to improvise here.
 */

const router = Router();
router.use(requireCustomerAuth);
router.use(customerTenantContextMiddleware);

/**
 * A customer's own unpaid invoices with due dates — needed to split
 * "overdue" from "upcoming" on the customer portal dashboard. Distinct
 * from /me/payments (which is the full posted ledger, at the journal-
 * entry level, with no per-invoice due date) — this is invoice-level,
 * specifically for the due-date bucketing the ledger can't give.
 */
router.get("/me/outstanding-invoices", asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(
    `select invoice_no, invoice_date, due_date, total
     from sales_invoices
     where customer_id = $1 and status = 'posted'
     order by due_date asc nulls last`,
    [req.customer!.customerId],
  );
  return res.status(200).json(rows);
}));

/**
 * Self-service payment/transaction history — the real posted ledger
 * for this customer (opening balance, every movement, running
 * balance), the exact same data source the business-side reconciled
 * "party ledger" report uses. Far more accurate than whatever the
 * legacy `transactions` Supabase table was (or wasn't) tracking.
 */
router.get("/me/payments", asyncHandler(async (req: Request, res: Response) => {
  const fromDate = typeof req.query.fromDate === "string" ? req.query.fromDate : "1900-01-01";
  const toDate = typeof req.query.toDate === "string" ? req.query.toDate : new Date().toISOString().slice(0, 10);
  const ledger = await partyLedger("customer", req.customer!.customerId, fromDate, toDate);
  return res.status(200).json(ledger);
}));

router.get("/me/requests", asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(
    `select id, subject, description, status, created_at, updated_at
     from customer_requests
     where customer_id = $1
     order by created_at desc`,
    [req.customer!.customerId],
  );
  return res.status(200).json(rows);
}));

router.post("/me/requests", asyncHandler(async (req: Request, res: Response) => {
  const subject = String(req.body?.subject ?? "").trim();
  const description = req.body?.description != null ? String(req.body.description).trim() : null;
  if (!subject) {
    return res.status(400).json({ error: "subject is required." });
  }

  const customerId = req.customer!.customerId;
  const created = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into customer_requests (customer_id, subject, description, status)
       values ($1, $2, $3, 'Open')
       returning id, subject, description, status, created_at, updated_at`,
      [customerId, subject, description],
    );
    await writeAudit(client, {
      userId: null,
      action: "create",
      module: "customer_requests",
      recordId: rows[0].id,
      newValue: rows[0],
    });
    return rows[0];
  });

  return res.status(201).json(created);
}));

router.get("/me/documents", asyncHandler(async (req: Request, res: Response) => {
  // FIX (production-readiness follow-up): my-documents.html previously
  // read from a `documents` table that has never existed anywhere in
  // this backend's schema (only employee_documents and
  // project_documents, neither customer-facing) -- every request
  // silently fell through to an empty state. Real file/PDF storage
  // (S3 or similar) is still a genuine feature to build, not something
  // to fake here, but a customer's own posted invoices and receipts
  // ARE real, meaningful "documents" that already exist -- returning
  // those is an honest improvement over a permanently empty screen,
  // not a pretend migration. document_url is intentionally omitted
  // (no file exists to link to); the frontend already renders a
  // disabled "View" button when it's absent.
  const customerId = req.customer!.customerId;
  const { rows: invoices } = await query(
    `select invoice_no, invoice_date, total, status
     from sales_invoices
     where customer_id = $1 and status in ('posted', 'cancelled')
     order by invoice_date desc`,
    [customerId],
  );
  const { rows: receipts } = await query(
    `select receipt_no, receipt_date, amount, status
     from receipts
     where customer_id = $1 and status in ('posted', 'cancelled')
     order by receipt_date desc`,
    [customerId],
  );

  const documents = [
    ...invoices.map((inv) => ({
      document_name: `Invoice ${inv.invoice_no}`,
      document_type: "invoice",
      document_date: inv.invoice_date,
      remarks: `${inv.status === "cancelled" ? "Cancelled — " : ""}Amount: ${inv.total}`,
      document_url: null,
    })),
    ...receipts.map((rec) => ({
      document_name: `Receipt ${rec.receipt_no}`,
      document_type: "receipt",
      document_date: rec.receipt_date,
      remarks: `${rec.status === "cancelled" ? "Cancelled — " : ""}Amount: ${rec.amount}`,
      document_url: null,
    })),
  ].sort((a, b) => new Date(b.document_date).getTime() - new Date(a.document_date).getTime());

  return res.status(200).json(documents);
}));

export default router;
