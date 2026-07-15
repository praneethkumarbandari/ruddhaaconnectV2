import type { PgClient } from "../db/pool.ts";
import { postJournalEntry, reverseJournalEntry, type PostingLineInput } from "./posting-engine.ts";
import { nextDocumentNumber } from "./number-generator.ts";
import { requireOpenFinancialYear } from "./fy.ts";
import { writeAudit } from "./audit.ts";
import { getControlAccountCode } from "./control-accounts.ts";

export type ReceiptAllocationInput = {
  salesInvoiceId: number;
  allocatedAmount: number;
};

export type CreateDraftReceiptInput = {
  customerId: number;
  receiptDate: string;
  amount: number;
  bankAccountCode: string;
  allocations: ReceiptAllocationInput[]; // sum can be <= amount; remainder is an unallocated advance
  narration?: string;
  userId: number | null;
  projectId?: number | null;
};

export class OverAllocationError extends Error {
  constructor(allocated: number, amount: number) {
    super(`Allocated amount (${allocated}) exceeds receipt amount (${amount}).`);
    this.name = "OverAllocationError";
  }
}

// FIX (SAT defect #2): createDraftReceipt previously only checked that
// allocations summed to <= the receipt's own amount. It never checked
// an allocation against the actual remaining outstanding balance of the
// invoice being allocated to. Proven live: a receipt could allocate an
// arbitrary amount to a single already-settled invoice and post
// successfully, driving that customer's outstanding to a false negative
// (credit) balance with no error at any stage.
export class AllocationInvoiceNotFoundError extends Error {
  constructor(id: number) {
    super(`Sales invoice ${id} not found.`);
    this.name = "AllocationInvoiceNotFoundError";
  }
}
export class AllocationInvoiceNotPostedError extends Error {
  constructor(id: number, status: string) {
    super(`Sales invoice ${id} is ${status} — only a posted invoice can receive a receipt allocation.`);
    this.name = "AllocationInvoiceNotPostedError";
  }
}
export class AllocationExceedsOutstandingError extends Error {
  constructor(invoiceId: number, invoiceNo: string | null, requested: number, remaining: number) {
    super(
      `Allocation of ${requested} to sales invoice ${invoiceNo ?? invoiceId} exceeds its remaining outstanding ` +
        `balance of ${remaining}.`,
    );
    this.name = "AllocationExceedsOutstandingError";
  }
}

/**
 * Remaining outstanding = invoice total - sum of allocations already
 * recorded against it from any receipt that isn't cancelled. Draft
 * receipts are included deliberately (not just posted ones): a draft
 * receipt's allocation rows are written immediately at draft-creation
 * time (see below), so treating only posted allocations as "reserved"
 * would let two concurrent drafts each pass validation and then
 * jointly over-allocate once both are posted. This is a validation
 * fix only — it does not change what draft/post/cancel do.
 */
async function remainingOutstandingForInvoice(client: PgClient, salesInvoiceId: number) {
  const { rows: invRows } = await client.query(
    `select id, invoice_no, total, status from sales_invoices where id = $1`,
    [salesInvoiceId],
  );
  if (invRows.length === 0) throw new AllocationInvoiceNotFoundError(salesInvoiceId);
  const invoice = invRows[0];
  if (invoice.status !== "posted") {
    throw new AllocationInvoiceNotPostedError(salesInvoiceId, invoice.status);
  }

  const { rows: allocRows } = await client.query(
    `select coalesce(sum(ra.allocated_amount), 0) as already_allocated
     from receipt_allocations ra
     join receipts r on r.id = ra.receipt_id
     where ra.sales_invoice_id = $1 and r.status != 'cancelled'`,
    [salesInvoiceId],
  );
  const alreadyAllocated = Number(allocRows[0].already_allocated);
  return { invoice, remaining: Number(invoice.total) - alreadyAllocated };
}

export async function createDraftReceipt(client: PgClient, input: CreateDraftReceiptInput) {
  const allocatedTotal = input.allocations.reduce((s, a) => s + a.allocatedAmount, 0);
  if (Math.round(allocatedTotal * 100) > Math.round(input.amount * 100)) {
    throw new OverAllocationError(allocatedTotal, input.amount);
  }

  // Combine allocations targeting the same invoice within this single
  // request before checking against outstanding balance, so a request
  // listing the same invoice twice can't bypass the check.
  const perInvoiceRequested = new Map<number, number>();
  for (const a of input.allocations) {
    perInvoiceRequested.set(a.salesInvoiceId, (perInvoiceRequested.get(a.salesInvoiceId) ?? 0) + a.allocatedAmount);
  }
  for (const [salesInvoiceId, requestedAmount] of perInvoiceRequested) {
    const { invoice, remaining } = await remainingOutstandingForInvoice(client, salesInvoiceId);
    if (Math.round(requestedAmount * 100) > Math.round(remaining * 100)) {
      throw new AllocationExceedsOutstandingError(salesInvoiceId, invoice.invoice_no, requestedAmount, remaining);
    }
  }

  const { rows } = await client.query(
    `insert into receipts (customer_id, receipt_date, amount, bank_account_code, narration, created_by, project_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [input.customerId, input.receiptDate, input.amount, input.bankAccountCode, input.narration ?? null, input.userId, input.projectId ?? null],
  );
  const receipt = rows[0];

  for (const alloc of input.allocations) {
    await client.query(
      `insert into receipt_allocations (receipt_id, sales_invoice_id, allocated_amount) values ($1, $2, $3)`,
      [receipt.id, alloc.salesInvoiceId, alloc.allocatedAmount],
    );
  }

  await writeAudit(client, {
    userId: input.userId,
    action: "create",
    module: "receipt",
    recordId: receipt.id,
    newValue: { ...receipt, allocations: input.allocations },
  });

  return receipt;
}

export class ReceiptNotFoundError extends Error {
  constructor(id: number) {
    super(`Receipt ${id} not found.`);
    this.name = "ReceiptNotFoundError";
  }
}
export class ReceiptNotDraftError extends Error {
  constructor(id: number, status: string) {
    super(`Receipt ${id} is ${status}, not draft.`);
    this.name = "ReceiptNotDraftError";
  }
}

/**
 * Posting: Dr Bank/Cash (amount) / Cr Trade Debtors (amount). The
 * allocation rows already recorded at draft time are what makes this
 * receipt attributable to specific invoices for outstanding
 * reporting — the journal entry itself only needs to move money
 * between the bank account and the customer control account.
 */
export async function postReceipt(client: PgClient, receiptId: number, userId: number | null) {
  const { rows: recRows } = await client.query(
    `select r.*, c.customer_name from receipts r join customers c on c.id = r.customer_id where r.id = $1`,
    [receiptId],
  );
  if (recRows.length === 0) throw new ReceiptNotFoundError(receiptId);
  const receipt = recRows[0];
  if (receipt.status !== "draft") throw new ReceiptNotDraftError(receiptId, receipt.status);

  const fy = await requireOpenFinancialYear(client, receipt.receipt_date.toISOString().slice(0, 10));
  const receiptNo = await nextDocumentNumber(client, "receipt", fy.id);
  const tradeDebtors = await getControlAccountCode("sundry_debtors");

  const lines: PostingLineInput[] = [
    { accountCode: receipt.bank_account_code, debit: Number(receipt.amount), credit: 0, narration: `Receipt ${receiptNo}` },
    {
      accountCode: tradeDebtors,
      debit: 0,
      credit: Number(receipt.amount),
      narration: `Receipt ${receiptNo}`,
      partyType: "customer",
      partyId: receipt.customer_id,
    },
  ];

  const posted = await postJournalEntry(client, {
    entryDate: receipt.receipt_date.toISOString().slice(0, 10),
    narration: `Receipt ${receiptNo} — ${receipt.customer_name}`,
    sourceType: "receipt",
    sourceId: receipt.id,
    lines,
    userId,
  });

  const { rows: updatedRows } = await client.query(
    `update receipts set status = 'posted', receipt_no = $1, journal_entry_id = $2, posted_at = now(), financial_year_id = $4 where id = $3 returning *`,
    [receiptNo, posted.id, receiptId, fy.id],
  );

  await writeAudit(client, {
    userId,
    action: "post",
    module: "receipt",
    recordId: receiptId,
    newValue: { receiptNo, journalEntryId: posted.id },
  });

  return updatedRows[0];
}

export class ReceiptNotPostedError extends Error {
  constructor(id: number, status: string) {
    super(`Receipt ${id} is ${status} — only a posted receipt can be cancelled.`);
    this.name = "ReceiptNotPostedError";
  }
}

export class ReceiptHasAllocationsError extends Error {
  constructor(id: number, count: number) {
    super(
      `Receipt ${id} has ${count} invoice allocation(s) recorded against it and cannot be cancelled directly. ` +
        `Remove or reverse the allocation(s) first.`,
    );
    this.name = "ReceiptHasAllocationsError";
  }
}

export class ReceiptAllocationNotFoundError extends Error {
  constructor(receiptId: number, salesInvoiceId: number) {
    super(`Receipt ${receiptId} has no allocation against sales invoice ${salesInvoiceId}.`);
    this.name = "ReceiptAllocationNotFoundError";
  }
}

/**
 * FIX: ReceiptHasAllocationsError's own message has always said "remove
 * or reverse the allocation(s) first" -- but no function anywhere ever
 * implemented that removal, meaning any receipt created with even one
 * allocation could never be cancelled through this API, permanently.
 * Found live: tried to cancel a fully-allocated receipt to test
 * re-allocation after cancellation, and hit a dead end with no code
 * path out of it.
 *
 * Removing an allocation does NOT reverse the receipt's own journal
 * entry (the cash side is real and unaffected by which invoice it was
 * applied to) -- it only removes the bookkeeping link, which correctly
 * increases both the invoice's remaining outstanding balance (it's
 * less paid-down now) and the receipt's own effectively-unallocated
 * amount (more of it counts as an unapplied advance now). Blocked once
 * the receipt is already cancelled, since there's nothing meaningful
 * left to unlink at that point.
 */
export async function removeReceiptAllocation(
  client: PgClient,
  receiptId: number,
  salesInvoiceId: number,
  userId: number | null,
) {
  const { rows: receiptRows } = await client.query(`select * from receipts where id = $1`, [receiptId]);
  if (receiptRows.length === 0) throw new ReceiptNotFoundError(receiptId);
  const receipt = receiptRows[0];
  if (receipt.status === "cancelled") throw new ReceiptNotPostedError(receiptId, receipt.status);

  const { rows: deleted } = await client.query(
    `delete from receipt_allocations where receipt_id = $1 and sales_invoice_id = $2 returning *`,
    [receiptId, salesInvoiceId],
  );
  if (deleted.length === 0) throw new ReceiptAllocationNotFoundError(receiptId, salesInvoiceId);

  await writeAudit(client, {
    userId,
    action: "update",
    module: "receipt_allocations",
    recordId: receiptId,
    oldValue: deleted[0],
    newValue: null,
  });

  return { receiptId, salesInvoiceId, removed: true };
}

export async function cancelReceipt(client: PgClient, receiptId: number, userId: number | null, reason: string) {
  const { rows } = await client.query(`select * from receipts where id = $1`, [receiptId]);
  if (rows.length === 0) throw new ReceiptNotFoundError(receiptId);
  const receipt = rows[0];
  if (receipt.status !== "posted") throw new ReceiptNotPostedError(receiptId, receipt.status);

  const { rows: allocRows } = await client.query(
    `select count(*)::int as count from receipt_allocations where receipt_id = $1`,
    [receiptId],
  );
  if (allocRows[0].count > 0) throw new ReceiptHasAllocationsError(receiptId, allocRows[0].count);

  await reverseJournalEntry(client, receipt.journal_entry_id, userId, reason);

  const { rows: updatedRows } = await client.query(
    `update receipts set status = 'cancelled' where id = $1 returning *`,
    [receiptId],
  );

  await writeAudit(client, {
    userId,
    action: "cancel",
    module: "receipt",
    recordId: receiptId,
    oldValue: { status: receipt.status },
    newValue: { status: "cancelled" },
  });

  return updatedRows[0];
}
