import type { PgClient } from "../db/pool.ts";
import { postJournalEntry, reverseJournalEntry, type PostingLineInput } from "./posting-engine.ts";
import { nextDocumentNumber } from "./number-generator.ts";
import { requireOpenFinancialYear } from "./fy.ts";
import { splitGst, computeLineTotals, type SupplyType } from "./gst.ts";
import { writeAudit } from "./audit.ts";
import { getControlAccountCode } from "./control-accounts.ts";

const SALES = "4000";
const OUTPUT_CGST = "2151";
const OUTPUT_SGST = "2152";
const OUTPUT_IGST = "2153";

export type SalesInvoiceLineInput = {
  description: string;
  qty: number;
  rate: number;
  gstRate: number;
  hsn?: string | null;
  itemId?: number | null;
};

export type CreateSalesInvoiceInput = {
  customerId: number;
  invoiceDate: string;
  dueDate?: string | null;
  lines: SalesInvoiceLineInput[];
  narration?: string;
  userId: number | null;
  // Project Management integration: purely a passive tag stored on the
  // document, never read by any pricing/GST/posting logic in this file.
  projectId?: number | null;
};

/** Draft only — no posting engine call, no journal entry, no ledger impact. */
export async function createDraftSalesInvoice(client: PgClient, input: CreateSalesInvoiceInput) {
  const { subtotal, gstAmount, total } = computeLineTotals(
    input.lines.map((l) => ({ qty: l.qty, rate: l.rate, gstRate: l.gstRate })),
  );

  const { rows } = await client.query(
    `insert into sales_invoices (customer_id, invoice_date, due_date, subtotal, gst_amount, total, narration, created_by, project_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [input.customerId, input.invoiceDate, input.dueDate ?? null, subtotal, gstAmount, total, input.narration ?? null, input.userId, input.projectId ?? null],
  );
  const invoice = rows[0];

  let lineNo = 1;
  for (const line of input.lines) {
    const lineAmount = Math.round(line.qty * line.rate * 100) / 100;
    await client.query(
      `insert into sales_invoice_lines (sales_invoice_id, description, qty, rate, gst_rate, line_amount, line_no, hsn, item_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [invoice.id, line.description, line.qty, line.rate, line.gstRate, lineAmount, lineNo++, line.hsn ?? null, line.itemId ?? null],
    );
  }

  await writeAudit(client, {
    userId: input.userId,
    action: "create",
    module: "sales_invoice",
    recordId: invoice.id,
    newValue: invoice,
  });

  return invoice;
}

export class InvoiceNotFoundError extends Error {
  constructor(id: number) {
    super(`Sales invoice ${id} not found.`);
    this.name = "InvoiceNotFoundError";
  }
}

export class InvoiceNotDraftError extends Error {
  constructor(id: number, status: string) {
    super(`Sales invoice ${id} is ${status}, not draft — only a draft invoice can be edited or posted.`);
    this.name = "InvoiceNotDraftError";
  }
}

/**
 * FIX (Invoice List Actions): draft invoices had no Edit path at
 * all — only Create and Post existed, so a mistake on a draft could
 * only be fixed by starting over. This is the missing piece.
 *
 * Deliberately draft-only, same as postSalesInvoice() — reuses
 * InvoiceNotDraftError rather than inventing a second "not editable"
 * concept, and the guard is checked FIRST, before touching any line
 * data, so a posted invoice is never partially modified before the
 * rejection is raised. Posted invoices remain genuinely immutable;
 * correcting one means Reverse (see reverseJournalEntry / the
 * standardized "Reverse" action), never editing it in place.
 *
 * Replaces every line rather than diffing old vs new — simplest
 * correct approach for a draft, which has no ledger impact yet to
 * preserve continuity with.
 */
export async function updateDraftSalesInvoice(client: PgClient, invoiceId: number, input: CreateSalesInvoiceInput) {
  const { rows: existingRows } = await client.query(`select * from sales_invoices where id = $1`, [invoiceId]);
  if (existingRows.length === 0) throw new InvoiceNotFoundError(invoiceId);
  const existing = existingRows[0];
  if (existing.status !== "draft") throw new InvoiceNotDraftError(invoiceId, existing.status);

  const { subtotal, gstAmount, total } = computeLineTotals(
    input.lines.map((l) => ({ qty: l.qty, rate: l.rate, gstRate: l.gstRate })),
  );

  const { rows } = await client.query(
    `update sales_invoices set
       customer_id = $2, invoice_date = $3, due_date = $4,
       subtotal = $5, gst_amount = $6, total = $7, narration = $8, project_id = $9
     where id = $1
     returning *`,
    [invoiceId, input.customerId, input.invoiceDate, input.dueDate ?? null, subtotal, gstAmount, total, input.narration ?? null, input.projectId ?? null],
  );
  const invoice = rows[0];

  await client.query(`delete from sales_invoice_lines where sales_invoice_id = $1`, [invoiceId]);
  let lineNo = 1;
  for (const line of input.lines) {
    const lineAmount = Math.round(line.qty * line.rate * 100) / 100;
    await client.query(
      `insert into sales_invoice_lines (sales_invoice_id, description, qty, rate, gst_rate, line_amount, line_no, hsn, item_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [invoiceId, line.description, line.qty, line.rate, line.gstRate, lineAmount, lineNo++, line.hsn ?? null, line.itemId ?? null],
    );
  }

  await writeAudit(client, {
    userId: input.userId,
    action: "update",
    module: "sales_invoice",
    recordId: invoiceId,
    oldValue: existing,
    newValue: invoice,
  });

  return invoice;
}

/**
 * Posts a draft sales invoice. This is the ONLY place a sales invoice
 * touches the ledger, and it does so by calling the exact same
 * postJournalEntry() every other module uses — no separate posting
 * logic for sales.
 *
 * Posting: Dr Trade Debtors (total) / Cr Sales (subtotal) / Cr Output
 * GST (split by the customer's supply_type).
 */
export async function postSalesInvoice(client: PgClient, invoiceId: number, userId: number | null) {
  const { rows: invRows } = await client.query(
    `select si.*, c.customer_name, c.supply_type from sales_invoices si
     join customers c on c.id = si.customer_id
     where si.id = $1`,
    [invoiceId],
  );
  if (invRows.length === 0) throw new InvoiceNotFoundError(invoiceId);
  const invoice = invRows[0];
  if (invoice.status !== "draft") throw new InvoiceNotDraftError(invoiceId, invoice.status);

  const gst = splitGst(Number(invoice.gst_amount), invoice.supply_type as SupplyType);
  const fy = await requireOpenFinancialYear(client, invoice.invoice_date.toISOString().slice(0, 10));
  const invoiceNo = await nextDocumentNumber(client, "invoice", fy.id);
  const tradeDebtors = await getControlAccountCode("sundry_debtors");

  const lines: PostingLineInput[] = [
    {
      accountCode: tradeDebtors,
      debit: Number(invoice.total),
      credit: 0,
      narration: `Sales invoice ${invoiceNo}`,
      partyType: "customer",
      partyId: invoice.customer_id,
    },
    { accountCode: SALES, debit: 0, credit: Number(invoice.subtotal), narration: `Sales invoice ${invoiceNo}` },
  ];
  if (gst.cgst > 0) lines.push({ accountCode: OUTPUT_CGST, debit: 0, credit: gst.cgst, narration: `Sales invoice ${invoiceNo}` });
  if (gst.sgst > 0) lines.push({ accountCode: OUTPUT_SGST, debit: 0, credit: gst.sgst, narration: `Sales invoice ${invoiceNo}` });
  if (gst.igst > 0) lines.push({ accountCode: OUTPUT_IGST, debit: 0, credit: gst.igst, narration: `Sales invoice ${invoiceNo}` });

  const posted = await postJournalEntry(client, {
    entryDate: invoice.invoice_date.toISOString().slice(0, 10),
    narration: `Sales invoice ${invoiceNo} — ${invoice.customer_name}`,
    sourceType: "invoice",
    sourceId: invoice.id,
    lines,
    userId,
  });

  const { rows: updatedRows } = await client.query(
    `update sales_invoices
     set status = 'posted', invoice_no = $1, journal_entry_id = $2, posted_at = now(), financial_year_id = $4
     where id = $3
     returning *`,
    [invoiceNo, posted.id, invoiceId, fy.id],
  );

  await writeAudit(client, {
    userId,
    action: "post",
    module: "sales_invoice",
    recordId: invoiceId,
    newValue: { invoiceNo, journalEntryId: posted.id },
  });

  return updatedRows[0];
}

export class InvoiceNotPostedError extends Error {
  constructor(id: number, status: string) {
    super(`Sales invoice ${id} is ${status} — only a posted invoice can be cancelled.`);
    this.name = "InvoiceNotPostedError";
  }
}

export class InvoiceHasAllocationsError extends Error {
  constructor(id: number, count: number) {
    super(
      `Sales invoice ${id} has ${count} receipt allocation(s) against it and cannot be cancelled directly. ` +
        `Reverse or reallocate the associated receipt(s) first.`,
    );
    this.name = "InvoiceHasAllocationsError";
  }
}

/**
 * Cancels a posted sales invoice by reversing its journal entry —
 * reuses reverseJournalEntry() from the posting engine exactly as-is.
 * The invoice row itself is marked cancelled but never deleted or
 * edited, matching the immutability rule.
 *
 * Guard: reverseJournalEntry() correctly fixes outstanding/ledger
 * (those are derived live from journal_entry_lines), but it does not
 * — and must not — touch receipt_allocations, since that table belongs
 * to the receipt, not the invoice. If a receipt has already allocated
 * money against this invoice, cancelling silently would leave that
 * allocation row pointing at a cancelled invoice: stale, misleading
 * data with no code path to clean it up. Block it instead and make
 * the caller resolve the receipt side first.
 */
export async function cancelSalesInvoice(client: PgClient, invoiceId: number, userId: number | null, reason: string) {
  const { rows } = await client.query(`select * from sales_invoices where id = $1`, [invoiceId]);
  if (rows.length === 0) throw new InvoiceNotFoundError(invoiceId);
  const invoice = rows[0];
  if (invoice.status !== "posted") throw new InvoiceNotPostedError(invoiceId, invoice.status);

  const { rows: allocRows } = await client.query(
    `select count(*)::int as count from receipt_allocations where sales_invoice_id = $1`,
    [invoiceId],
  );
  if (allocRows[0].count > 0) throw new InvoiceHasAllocationsError(invoiceId, allocRows[0].count);

  await reverseJournalEntry(client, invoice.journal_entry_id, userId, reason);

  const { rows: updatedRows } = await client.query(
    `update sales_invoices set status = 'cancelled' where id = $1 returning *`,
    [invoiceId],
  );

  await writeAudit(client, {
    userId,
    action: "cancel",
    module: "sales_invoice",
    recordId: invoiceId,
    oldValue: { status: invoice.status },
    newValue: { status: "cancelled" },
  });

  return updatedRows[0];
}
