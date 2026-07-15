import type { PgClient } from "../db/pool.ts";
import { postJournalEntry, reverseJournalEntry, type PostingLineInput } from "./posting-engine.ts";
import { nextDocumentNumber } from "./number-generator.ts";
import { requireOpenFinancialYear } from "./fy.ts";
import { splitGst, computeLineTotals, type SupplyType } from "./gst.ts";
import { writeAudit } from "./audit.ts";
import { getControlAccountCode } from "./control-accounts.ts";

const PURCHASES = "5000";
const INPUT_CGST = "1161";
const INPUT_SGST = "1162";
const INPUT_IGST = "1163";

export type PurchaseInvoiceLineInput = {
  description: string;
  qty: number;
  rate: number;
  gstRate: number;
  hsn?: string | null;
  itemId?: number | null;
};

export type CreatePurchaseInvoiceInput = {
  vendorId: number;
  invoiceDate: string;
  dueDate?: string | null;
  vendorInvoiceNo?: string;
  lines: PurchaseInvoiceLineInput[];
  narration?: string;
  userId: number | null;
  projectId?: number | null;
};

export async function createDraftPurchaseInvoice(client: PgClient, input: CreatePurchaseInvoiceInput) {
  const { subtotal, gstAmount, total } = computeLineTotals(
    input.lines.map((l) => ({ qty: l.qty, rate: l.rate, gstRate: l.gstRate })),
  );

  const { rows } = await client.query(
    `insert into purchase_invoices (vendor_id, invoice_date, due_date, vendor_invoice_no, subtotal, gst_amount, total, narration, created_by, project_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [input.vendorId, input.invoiceDate, input.dueDate ?? null, input.vendorInvoiceNo ?? null, subtotal, gstAmount, total, input.narration ?? null, input.userId, input.projectId ?? null],
  );
  const invoice = rows[0];

  let lineNo = 1;
  for (const line of input.lines) {
    const lineAmount = Math.round(line.qty * line.rate * 100) / 100;
    await client.query(
      `insert into purchase_invoice_lines (purchase_invoice_id, description, qty, rate, gst_rate, line_amount, line_no, hsn, item_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [invoice.id, line.description, line.qty, line.rate, line.gstRate, lineAmount, lineNo++, line.hsn ?? null, line.itemId ?? null],
    );
  }

  await writeAudit(client, {
    userId: input.userId,
    action: "create",
    module: "purchase_invoice",
    recordId: invoice.id,
    newValue: invoice,
  });

  return invoice;
}

export class PurchaseNotFoundError extends Error {
  constructor(id: number) {
    super(`Purchase invoice ${id} not found.`);
    this.name = "PurchaseNotFoundError";
  }
}

export class PurchaseNotDraftError extends Error {
  constructor(id: number, status: string) {
    super(`Purchase invoice ${id} is ${status}, not draft — only a draft invoice can be edited or posted.`);
    this.name = "PurchaseNotDraftError";
  }
}

/** See updateDraftSalesInvoice()'s own comment in sales.ts — same fix, same reasoning, mirrored for purchases. */
export async function updateDraftPurchaseInvoice(client: PgClient, invoiceId: number, input: CreatePurchaseInvoiceInput) {
  const { rows: existingRows } = await client.query(`select * from purchase_invoices where id = $1`, [invoiceId]);
  if (existingRows.length === 0) throw new PurchaseNotFoundError(invoiceId);
  const existing = existingRows[0];
  if (existing.status !== "draft") throw new PurchaseNotDraftError(invoiceId, existing.status);

  const { subtotal, gstAmount, total } = computeLineTotals(
    input.lines.map((l) => ({ qty: l.qty, rate: l.rate, gstRate: l.gstRate })),
  );

  const { rows } = await client.query(
    `update purchase_invoices set
       vendor_id = $2, invoice_date = $3, due_date = $4, vendor_invoice_no = $5,
       subtotal = $6, gst_amount = $7, total = $8, narration = $9, project_id = $10
     where id = $1
     returning *`,
    [invoiceId, input.vendorId, input.invoiceDate, input.dueDate ?? null, input.vendorInvoiceNo ?? null, subtotal, gstAmount, total, input.narration ?? null, input.projectId ?? null],
  );
  const invoice = rows[0];

  await client.query(`delete from purchase_invoice_lines where purchase_invoice_id = $1`, [invoiceId]);
  let lineNo = 1;
  for (const line of input.lines) {
    const lineAmount = Math.round(line.qty * line.rate * 100) / 100;
    await client.query(
      `insert into purchase_invoice_lines (purchase_invoice_id, description, qty, rate, gst_rate, line_amount, line_no, hsn, item_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [invoiceId, line.description, line.qty, line.rate, line.gstRate, lineAmount, lineNo++, line.hsn ?? null, line.itemId ?? null],
    );
  }

  await writeAudit(client, {
    userId: input.userId,
    action: "update",
    module: "purchase_invoice",
    recordId: invoiceId,
    oldValue: existing,
    newValue: invoice,
  });

  return invoice;
}

/** Posting: Dr Purchases + Dr Input GST (split) / Cr Trade Creditors (total). */
export async function postPurchaseInvoice(client: PgClient, invoiceId: number, userId: number | null) {
  const { rows: invRows } = await client.query(
    `select pi.*, v.vendor_name, v.supply_type from purchase_invoices pi
     join vendors v on v.id = pi.vendor_id
     where pi.id = $1`,
    [invoiceId],
  );
  if (invRows.length === 0) throw new PurchaseNotFoundError(invoiceId);
  const invoice = invRows[0];
  if (invoice.status !== "draft") throw new PurchaseNotDraftError(invoiceId, invoice.status);

  const gst = splitGst(Number(invoice.gst_amount), invoice.supply_type as SupplyType);
  const fy = await requireOpenFinancialYear(client, invoice.invoice_date.toISOString().slice(0, 10));
  const purchaseNo = await nextDocumentNumber(client, "purchase", fy.id);

  const lines: PostingLineInput[] = [
    { accountCode: PURCHASES, debit: Number(invoice.subtotal), credit: 0, narration: `Purchase ${purchaseNo}` },
  ];
  if (gst.cgst > 0) lines.push({ accountCode: INPUT_CGST, debit: gst.cgst, credit: 0, narration: `Purchase ${purchaseNo}` });
  if (gst.sgst > 0) lines.push({ accountCode: INPUT_SGST, debit: gst.sgst, credit: 0, narration: `Purchase ${purchaseNo}` });
  if (gst.igst > 0) lines.push({ accountCode: INPUT_IGST, debit: gst.igst, credit: 0, narration: `Purchase ${purchaseNo}` });
  const tradeCreditors = await getControlAccountCode("sundry_creditors");
  lines.push({
    accountCode: tradeCreditors,
    debit: 0,
    credit: Number(invoice.total),
    narration: `Purchase ${purchaseNo}`,
    partyType: "vendor",
    partyId: invoice.vendor_id,
  });

  const posted = await postJournalEntry(client, {
    entryDate: invoice.invoice_date.toISOString().slice(0, 10),
    narration: `Purchase ${purchaseNo} — ${invoice.vendor_name}`,
    sourceType: "purchase",
    sourceId: invoice.id,
    lines,
    userId,
  });

  const { rows: updatedRows } = await client.query(
    `update purchase_invoices
     set status = 'posted', purchase_no = $1, journal_entry_id = $2, posted_at = now(), financial_year_id = $4
     where id = $3
     returning *`,
    [purchaseNo, posted.id, invoiceId, fy.id],
  );

  await writeAudit(client, {
    userId,
    action: "post",
    module: "purchase_invoice",
    recordId: invoiceId,
    newValue: { purchaseNo, journalEntryId: posted.id },
  });

  return updatedRows[0];
}

export class PurchaseNotPostedError extends Error {
  constructor(id: number, status: string) {
    super(`Purchase invoice ${id} is ${status} — only a posted invoice can be cancelled.`);
    this.name = "PurchaseNotPostedError";
  }
}

export class PurchaseHasAllocationsError extends Error {
  constructor(id: number, count: number) {
    super(
      `Purchase invoice ${id} has ${count} payment allocation(s) against it and cannot be cancelled directly. ` +
        `Reverse or reallocate the associated payment(s) first.`,
    );
    this.name = "PurchaseHasAllocationsError";
  }
}

export async function cancelPurchaseInvoice(client: PgClient, invoiceId: number, userId: number | null, reason: string) {
  const { rows } = await client.query(`select * from purchase_invoices where id = $1`, [invoiceId]);
  if (rows.length === 0) throw new PurchaseNotFoundError(invoiceId);
  const invoice = rows[0];
  if (invoice.status !== "posted") throw new PurchaseNotPostedError(invoiceId, invoice.status);

  const { rows: allocRows } = await client.query(
    `select count(*)::int as count from payment_allocations where purchase_invoice_id = $1`,
    [invoiceId],
  );
  if (allocRows[0].count > 0) throw new PurchaseHasAllocationsError(invoiceId, allocRows[0].count);

  await reverseJournalEntry(client, invoice.journal_entry_id, userId, reason);

  const { rows: updatedRows } = await client.query(
    `update purchase_invoices set status = 'cancelled' where id = $1 returning *`,
    [invoiceId],
  );

  await writeAudit(client, {
    userId,
    action: "cancel",
    module: "purchase_invoice",
    recordId: invoiceId,
    oldValue: { status: invoice.status },
    newValue: { status: "cancelled" },
  });

  return updatedRows[0];
}
