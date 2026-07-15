import type { PgClient } from "../db/pool.ts";
import { postJournalEntry, reverseJournalEntry, type PostingLineInput } from "./posting-engine.ts";
import { nextDocumentNumber } from "./number-generator.ts";
import { requireOpenFinancialYear } from "./fy.ts";
import { writeAudit } from "./audit.ts";
import { getAccountBySpecialRole } from "./chart-of-accounts.ts";
import { getControlAccountCode } from "./control-accounts.ts";

export type PaymentAllocationInput = {
  purchaseInvoiceId: number;
  allocatedAmount: number;
};

export type CreateDraftPaymentInput = {
  vendorId: number;
  paymentDate: string;
  amount: number;
  bankAccountCode: string;
  allocations: PaymentAllocationInput[];
  narration?: string;
  userId: number | null;
  projectId?: number | null;
  // TDS: optional. If provided, this payment withholds tds_amount
  // instead of paying it in cash — the bank account is only debited
  // for (amount - tdsAmount), while `amount` still fully clears the
  // vendor's payable via allocations exactly as before. See
  // computeTds() for the actual rate/threshold logic.
  tdsSectionId?: number | null;
};

export class OverAllocationError extends Error {
  constructor(allocated: number, amount: number) {
    super(`Allocated amount (${allocated}) exceeds payment amount (${amount}).`);
    this.name = "OverAllocationError";
  }
}

// FIX (SAT defect #2, mirror of the receipts.ts fix): same missing
// check — allocations were only validated against the payment's own
// amount, never against the purchase invoice's actual remaining
// outstanding balance.
export class AllocationPurchaseNotFoundError extends Error {
  constructor(id: number) {
    super(`Purchase invoice ${id} not found.`);
    this.name = "AllocationPurchaseNotFoundError";
  }
}
export class AllocationPurchaseNotPostedError extends Error {
  constructor(id: number, status: string) {
    super(`Purchase invoice ${id} is ${status} — only a posted invoice can receive a payment allocation.`);
    this.name = "AllocationPurchaseNotPostedError";
  }
}
export class AllocationExceedsOutstandingError extends Error {
  constructor(purchaseId: number, purchaseNo: string | null, requested: number, remaining: number) {
    super(
      `Allocation of ${requested} to purchase invoice ${purchaseNo ?? purchaseId} exceeds its remaining outstanding ` +
        `balance of ${remaining}.`,
    );
    this.name = "AllocationExceedsOutstandingError";
  }
}

/** Same rationale as receipts.ts's remainingOutstandingForInvoice(): draft payments included deliberately. */
async function remainingOutstandingForPurchase(client: PgClient, purchaseInvoiceId: number) {
  const { rows: purRows } = await client.query(
    `select id, purchase_no, total, status from purchase_invoices where id = $1`,
    [purchaseInvoiceId],
  );
  if (purRows.length === 0) throw new AllocationPurchaseNotFoundError(purchaseInvoiceId);
  const purchase = purRows[0];
  if (purchase.status !== "posted") {
    throw new AllocationPurchaseNotPostedError(purchaseInvoiceId, purchase.status);
  }

  const { rows: allocRows } = await client.query(
    `select coalesce(sum(pa.allocated_amount), 0) as already_allocated
     from payment_allocations pa
     join payments p on p.id = pa.payment_id
     where pa.purchase_invoice_id = $1 and p.status != 'cancelled'`,
    [purchaseInvoiceId],
  );
  const alreadyAllocated = Number(allocRows[0].already_allocated);
  return { purchase, remaining: Number(purchase.total) - alreadyAllocated };
}

/**
 * Real TDS threshold logic: once EITHER threshold is crossed, TDS
 * applies to the full payment amount, not just the excess over the
 * threshold — this is how Indian TDS thresholds actually work (unlike
 * income tax slabs, which are marginal). aggregateSoFar is the FY-to-
 * date total already paid to this vendor BEFORE this payment; this
 * payment is included in the aggregate check as "would this payment
 * push the FY total over the threshold."
 */
async function computeTds(
  client: PgClient,
  vendorId: number,
  tdsSectionId: number,
  paymentAmount: number,
  fyStartDate: string,
  fyEndDate: string,
): Promise<{ rate: number; tdsAmount: number } | null> {
  const { rows: sectionRows } = await client.query(
    `select * from tds_sections where id = $1 and is_active = true`,
    [tdsSectionId],
  );
  if (sectionRows.length === 0) return null;
  const section = sectionRows[0];

  // FIX: payments.financial_year_id is only ever set when a payment
  // is POSTED (see postPayment()'s update statement) — a draft
  // payment has it null. Filtering this aggregate by that column
  // would silently exclude every other still-draft payment to the
  // same vendor this year, understating the true FY-to-date total
  // and potentially missing a real threshold crossing. Filtering by
  // the financial year's actual date range instead correctly
  // includes drafts and posted payments alike.
  const { rows: aggRows } = await client.query(
    `select coalesce(sum(p.amount), 0) as aggregate_so_far
     from payments p
     where p.vendor_id = $1 and p.status != 'cancelled'
       and p.payment_date between $2 and $3`,
    [vendorId, fyStartDate, fyEndDate],
  );
  const aggregateSoFar = Number(aggRows[0].aggregate_so_far);

  const exceedsSingle = section.threshold_single_payment != null && paymentAmount > Number(section.threshold_single_payment);
  const exceedsAggregate = section.threshold_aggregate_annual != null && (aggregateSoFar + paymentAmount) > Number(section.threshold_aggregate_annual);
  if (!exceedsSingle && !exceedsAggregate) return null;

  const rate = Number(section.rate_percentage);
  const tdsAmount = Math.round(paymentAmount * (rate / 100) * 100) / 100;
  return { rate, tdsAmount };
}

export async function createDraftPayment(client: PgClient, input: CreateDraftPaymentInput) {
  const allocatedTotal = input.allocations.reduce((s, a) => s + a.allocatedAmount, 0);
  if (Math.round(allocatedTotal * 100) > Math.round(input.amount * 100)) {
    throw new OverAllocationError(allocatedTotal, input.amount);
  }

  const perInvoiceRequested = new Map<number, number>();
  for (const a of input.allocations) {
    perInvoiceRequested.set(a.purchaseInvoiceId, (perInvoiceRequested.get(a.purchaseInvoiceId) ?? 0) + a.allocatedAmount);
  }
  for (const [purchaseInvoiceId, requestedAmount] of perInvoiceRequested) {
    const { purchase, remaining } = await remainingOutstandingForPurchase(client, purchaseInvoiceId);
    if (Math.round(requestedAmount * 100) > Math.round(remaining * 100)) {
      throw new AllocationExceedsOutstandingError(purchaseInvoiceId, purchase.purchase_no, requestedAmount, remaining);
    }
  }

  let tdsAmount = 0;
  if (input.tdsSectionId) {
    const { rows: fyRows } = await client.query(
      `select id, start_date, end_date from financial_years where $1::date between start_date and end_date`,
      [input.paymentDate],
    );
    if (fyRows.length > 0) {
      const fy = fyRows[0];
      const tds = await computeTds(client, input.vendorId, input.tdsSectionId, input.amount, fy.start_date, fy.end_date);
      if (tds) tdsAmount = tds.tdsAmount;
    }
  }

  const { rows } = await client.query(
    `insert into payments (vendor_id, payment_date, amount, bank_account_code, narration, created_by, project_id, tds_section_id, tds_amount)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [input.vendorId, input.paymentDate, input.amount, input.bankAccountCode, input.narration ?? null, input.userId, input.projectId ?? null, input.tdsSectionId ?? null, tdsAmount],
  );
  const payment = rows[0];

  if (input.tdsSectionId && tdsAmount > 0) {
    const { rows: fyRows2 } = await client.query(
      `select id from financial_years where $1::date between start_date and end_date`,
      [input.paymentDate],
    );
    const { rows: sectionRows2 } = await client.query(`select rate_percentage from tds_sections where id = $1`, [input.tdsSectionId]);
    const quarter = Math.ceil(((new Date(input.paymentDate).getMonth() + 12 - 3) % 12 + 1) / 3); // Indian FY quarter: Apr-Jun=Q1 ... Jan-Mar=Q4
    await client.query(
      `insert into tds_deductions (payment_id, vendor_id, tds_section_id, gross_amount, tds_rate, tds_amount, deduction_date, financial_year_id, quarter)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [payment.id, input.vendorId, input.tdsSectionId, input.amount, sectionRows2[0].rate_percentage, tdsAmount, input.paymentDate, fyRows2[0].id, quarter],
    );
  }

  for (const alloc of input.allocations) {
    await client.query(
      `insert into payment_allocations (payment_id, purchase_invoice_id, allocated_amount) values ($1, $2, $3)`,
      [payment.id, alloc.purchaseInvoiceId, alloc.allocatedAmount],
    );
  }

  await writeAudit(client, {
    userId: input.userId,
    action: "create",
    module: "payment",
    recordId: payment.id,
    newValue: { ...payment, allocations: input.allocations },
  });

  return payment;
}

export class PaymentNotFoundError extends Error {
  constructor(id: number) {
    super(`Payment ${id} not found.`);
    this.name = "PaymentNotFoundError";
  }
}
export class PaymentNotDraftError extends Error {
  constructor(id: number, status: string) {
    super(`Payment ${id} is ${status}, not draft.`);
    this.name = "PaymentNotDraftError";
  }
}

/** Posting: Dr Trade Creditors (amount) / Cr Bank/Cash (amount). */
export async function postPayment(client: PgClient, paymentId: number, userId: number | null) {
  const { rows: payRows } = await client.query(
    `select p.*, v.vendor_name from payments p join vendors v on v.id = p.vendor_id where p.id = $1`,
    [paymentId],
  );
  if (payRows.length === 0) throw new PaymentNotFoundError(paymentId);
  const payment = payRows[0];
  if (payment.status !== "draft") throw new PaymentNotDraftError(paymentId, payment.status);

  const fy = await requireOpenFinancialYear(client, payment.payment_date.toISOString().slice(0, 10));
  const paymentNo = await nextDocumentNumber(client, "payment", fy.id);

  const tdsAmount = Number(payment.tds_amount) || 0;
  const tradeCreditors = await getControlAccountCode("sundry_creditors");
  const lines: PostingLineInput[] = [
    {
      accountCode: tradeCreditors,
      debit: Number(payment.amount),
      credit: 0,
      narration: `Payment ${paymentNo}`,
      partyType: "vendor",
      partyId: payment.vendor_id,
    },
    { accountCode: payment.bank_account_code, debit: 0, credit: Number(payment.amount) - tdsAmount, narration: `Payment ${paymentNo}` },
  ];

  if (tdsAmount > 0) {
    const tdsAccount = await getAccountBySpecialRole("tds_payable");
    if (!tdsAccount) {
      throw new Error("TDS was deducted on this payment, but no account in Chart of Accounts is marked with the \"TDS Payable\" role — set that on the correct account before posting.");
    }
    lines.push({ accountCode: tdsAccount.account_code, debit: 0, credit: tdsAmount, narration: `TDS withheld — Payment ${paymentNo}` });
  }

  const posted = await postJournalEntry(client, {
    entryDate: payment.payment_date.toISOString().slice(0, 10),
    narration: `Payment ${paymentNo} — ${payment.vendor_name}`,
    sourceType: "payment",
    sourceId: payment.id,
    lines,
    userId,
  });

  const { rows: updatedRows } = await client.query(
    `update payments set status = 'posted', payment_no = $1, journal_entry_id = $2, posted_at = now(), financial_year_id = $4 where id = $3 returning *`,
    [paymentNo, posted.id, paymentId, fy.id],
  );

  await writeAudit(client, {
    userId,
    action: "post",
    module: "payment",
    recordId: paymentId,
    newValue: { paymentNo, journalEntryId: posted.id },
  });

  return updatedRows[0];
}

export class PaymentNotPostedError extends Error {
  constructor(id: number, status: string) {
    super(`Payment ${id} is ${status} — only a posted payment can be cancelled.`);
    this.name = "PaymentNotPostedError";
  }
}

export class PaymentHasAllocationsError extends Error {
  constructor(id: number, count: number) {
    super(
      `Payment ${id} has ${count} invoice allocation(s) recorded against it and cannot be cancelled directly. ` +
        `Remove or reverse the allocation(s) first.`,
    );
    this.name = "PaymentHasAllocationsError";
  }
}

export class PaymentAllocationNotFoundError extends Error {
  constructor(paymentId: number, purchaseInvoiceId: number) {
    super(`Payment ${paymentId} has no allocation against purchase invoice ${purchaseInvoiceId}.`);
    this.name = "PaymentAllocationNotFoundError";
  }
}

/**
 * FIX: same gap as receipts.ts's removeReceiptAllocation -- PaymentHasAllocationsError's
 * own message has always said "remove or reverse the allocation(s) first",
 * but no function anywhere ever implemented that removal, meaning any
 * payment created with even one allocation could never be cancelled
 * through this API.
 */
export async function removePaymentAllocation(
  client: PgClient,
  paymentId: number,
  purchaseInvoiceId: number,
  userId: number | null,
) {
  const { rows: paymentRows } = await client.query(`select * from payments where id = $1`, [paymentId]);
  if (paymentRows.length === 0) throw new PaymentNotFoundError(paymentId);
  const payment = paymentRows[0];
  if (payment.status === "cancelled") throw new PaymentNotPostedError(paymentId, payment.status);

  const { rows: deleted } = await client.query(
    `delete from payment_allocations where payment_id = $1 and purchase_invoice_id = $2 returning *`,
    [paymentId, purchaseInvoiceId],
  );
  if (deleted.length === 0) throw new PaymentAllocationNotFoundError(paymentId, purchaseInvoiceId);

  await writeAudit(client, {
    userId,
    action: "update",
    module: "payment_allocations",
    recordId: paymentId,
    oldValue: deleted[0],
    newValue: null,
  });

  return { paymentId, purchaseInvoiceId, removed: true };
}

export async function cancelPayment(client: PgClient, paymentId: number, userId: number | null, reason: string) {
  const { rows } = await client.query(`select * from payments where id = $1`, [paymentId]);
  if (rows.length === 0) throw new PaymentNotFoundError(paymentId);
  const payment = rows[0];
  if (payment.status !== "posted") throw new PaymentNotPostedError(paymentId, payment.status);

  const { rows: allocRows } = await client.query(
    `select count(*)::int as count from payment_allocations where payment_id = $1`,
    [paymentId],
  );
  if (allocRows[0].count > 0) throw new PaymentHasAllocationsError(paymentId, allocRows[0].count);

  await reverseJournalEntry(client, payment.journal_entry_id, userId, reason);

  // FIX: this never happened before. A cancelled payment's TDS
  // deduction stayed in tds_deductions as if it genuinely occurred —
  // Form 16A and 26Q summaries read directly from this table, so a
  // cancelled payment would overstate what was actually withheld and
  // remitted. Marked reversed, not deleted — same principle as
  // reverseJournalEntry() itself: the deduction genuinely happened
  // and was later reversed; that's a fact worth keeping, not erasing.
  if (Number(payment.tds_amount) > 0) {
    await client.query(
      `update tds_deductions set reversed_at = now() where payment_id = $1 and reversed_at is null`,
      [paymentId],
    );
  }

  const { rows: updatedRows } = await client.query(
    `update payments set status = 'cancelled' where id = $1 returning *`,
    [paymentId],
  );

  await writeAudit(client, {
    userId,
    action: "cancel",
    module: "payment",
    recordId: paymentId,
    oldValue: { status: payment.status },
    newValue: { status: "cancelled" },
  });

  return updatedRows[0];
}
