import type { PgClient } from "../db/pool.ts";
import { postJournalEntry, reverseJournalEntry, type PostingLineInput } from "./posting-engine.ts";
import { nextDocumentNumber } from "./number-generator.ts";
import { requireOpenFinancialYear } from "./fy.ts";
import { splitGst, computeLineTotals, type SupplyType } from "./gst.ts";
import { writeAudit } from "./audit.ts";
import { getControlAccountCode } from "./control-accounts.ts";

const SALES = "4000";
const PURCHASES = "5000";
const OUTPUT_CGST = "2151";
const OUTPUT_SGST = "2152";
const OUTPUT_IGST = "2153";
const INPUT_CGST = "1161";
const INPUT_SGST = "1162";
const INPUT_IGST = "1163";

export type NoteLineInput = { description: string; qty: number; rate: number; gstRate: number };

export class NoteNotFoundError extends Error {
  constructor(kind: string, id: number) {
    super(`${kind} ${id} not found.`);
    this.name = "NoteNotFoundError";
  }
}
export class NoteNotDraftError extends Error {
  constructor(kind: string, id: number, status: string) {
    super(`${kind} ${id} is ${status}, not draft.`);
    this.name = "NoteNotDraftError";
  }
}

export class NoteNotPostedError extends Error {
  constructor(kind: string, id: number, status: string) {
    super(`${kind} ${id} is ${status} — only a posted note can be cancelled.`);
    this.name = "NoteNotPostedError";
  }
}

/**
 * FIX: every other voucher type in this system (sales/purchase invoices,
 * receipts, payments) has a cancel operation that reverses its journal
 * entry. Credit and debit notes had none at all -- a note issued in
 * error, once posted, could never be reversed through this API. Unlike
 * receipts/payments, notes have no allocation table to check first
 * (against_invoice_id is a single reference, not a many-to-many
 * allocation), so this mirrors cancelReceipt's shape without that step.
 */
export async function cancelCreditNote(client: PgClient, noteId: number, userId: number | null, reason: string) {
  const { rows } = await client.query(`select * from credit_notes where id = $1`, [noteId]);
  if (rows.length === 0) throw new NoteNotFoundError("Credit note", noteId);
  const note = rows[0];
  if (note.status !== "posted") throw new NoteNotPostedError("Credit note", noteId, note.status);

  await reverseJournalEntry(client, note.journal_entry_id, userId, reason);

  const { rows: updated } = await client.query(
    `update credit_notes set status = 'cancelled' where id = $1 returning *`,
    [noteId],
  );
  await writeAudit(client, {
    userId, action: "cancel", module: "credit_note", recordId: noteId,
    oldValue: { status: note.status }, newValue: { status: "cancelled" },
  });
  return updated[0];
}

export async function cancelDebitNote(client: PgClient, noteId: number, userId: number | null, reason: string) {
  const { rows } = await client.query(`select * from debit_notes where id = $1`, [noteId]);
  if (rows.length === 0) throw new NoteNotFoundError("Debit note", noteId);
  const note = rows[0];
  if (note.status !== "posted") throw new NoteNotPostedError("Debit note", noteId, note.status);

  await reverseJournalEntry(client, note.journal_entry_id, userId, reason);

  const { rows: updated } = await client.query(
    `update debit_notes set status = 'cancelled' where id = $1 returning *`,
    [noteId],
  );
  await writeAudit(client, {
    userId, action: "cancel", module: "debit_note", recordId: noteId,
    oldValue: { status: note.status }, newValue: { status: "cancelled" },
  });
  return updated[0];
}
export type CreateDraftCreditNoteInput = {
  customerId: number;
  againstInvoiceId?: number;
  noteDate: string;
  lines: NoteLineInput[];
  narration?: string;
  userId: number | null;
  projectId?: number | null;
};

export async function createDraftCreditNote(client: PgClient, input: CreateDraftCreditNoteInput) {
  const { subtotal, gstAmount, total } = computeLineTotals(input.lines);
  const { rows } = await client.query(
    `insert into credit_notes (customer_id, against_invoice_id, note_date, subtotal, gst_amount, total, narration, created_by, project_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [input.customerId, input.againstInvoiceId ?? null, input.noteDate, subtotal, gstAmount, total, input.narration ?? null, input.userId, input.projectId ?? null],
  );
  await writeAudit(client, { userId: input.userId, action: "create", module: "credit_note", recordId: rows[0].id, newValue: rows[0] });
  return rows[0];
}

/** Posting: Dr Sales + Dr Output GST (reversing revenue) / Cr Trade Debtors (reducing what they owe). */
export async function postCreditNote(client: PgClient, noteId: number, userId: number | null) {
  const { rows: noteRows } = await client.query(
    `select cn.*, c.customer_name, c.supply_type from credit_notes cn
     join customers c on c.id = cn.customer_id where cn.id = $1`,
    [noteId],
  );
  if (noteRows.length === 0) throw new NoteNotFoundError("Credit note", noteId);
  const note = noteRows[0];
  if (note.status !== "draft") throw new NoteNotDraftError("Credit note", noteId, note.status);

  const gst = splitGst(Number(note.gst_amount), note.supply_type as SupplyType);
  const fy = await requireOpenFinancialYear(client, note.note_date.toISOString().slice(0, 10));
  const noteNo = await nextDocumentNumber(client, "credit_note", fy.id);

  const lines: PostingLineInput[] = [
    { accountCode: SALES, debit: Number(note.subtotal), credit: 0, narration: `Credit note ${noteNo}` },
  ];
  if (gst.cgst > 0) lines.push({ accountCode: OUTPUT_CGST, debit: gst.cgst, credit: 0, narration: `Credit note ${noteNo}` });
  if (gst.sgst > 0) lines.push({ accountCode: OUTPUT_SGST, debit: gst.sgst, credit: 0, narration: `Credit note ${noteNo}` });
  if (gst.igst > 0) lines.push({ accountCode: OUTPUT_IGST, debit: gst.igst, credit: 0, narration: `Credit note ${noteNo}` });
  const tradeDebtors = await getControlAccountCode("sundry_debtors");
  lines.push({
    accountCode: tradeDebtors,
    debit: 0,
    credit: Number(note.total),
    narration: `Credit note ${noteNo}`,
    partyType: "customer",
    partyId: note.customer_id,
  });

  const posted = await postJournalEntry(client, {
    entryDate: note.note_date.toISOString().slice(0, 10),
    narration: `Credit note ${noteNo} — ${note.customer_name}`,
    sourceType: "credit_note",
    sourceId: note.id,
    lines,
    userId,
  });

  const { rows: updated } = await client.query(
    `update credit_notes set status = 'posted', credit_note_no = $1, journal_entry_id = $2, posted_at = now(), financial_year_id = $4 where id = $3 returning *`,
    [noteNo, posted.id, noteId, fy.id],
  );
  await writeAudit(client, { userId, action: "post", module: "credit_note", recordId: noteId, newValue: { noteNo, journalEntryId: posted.id } });
  return updated[0];
}

export type CreateDraftDebitNoteInput = {
  vendorId: number;
  againstInvoiceId?: number;
  noteDate: string;
  lines: NoteLineInput[];
  narration?: string;
  userId: number | null;
  projectId?: number | null;
};

export async function createDraftDebitNote(client: PgClient, input: CreateDraftDebitNoteInput) {
  const { subtotal, gstAmount, total } = computeLineTotals(input.lines);
  const { rows } = await client.query(
    `insert into debit_notes (vendor_id, against_invoice_id, note_date, subtotal, gst_amount, total, narration, created_by, project_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [input.vendorId, input.againstInvoiceId ?? null, input.noteDate, subtotal, gstAmount, total, input.narration ?? null, input.userId, input.projectId ?? null],
  );
  await writeAudit(client, { userId: input.userId, action: "create", module: "debit_note", recordId: rows[0].id, newValue: rows[0] });
  return rows[0];
}

/** Posting: Dr Trade Creditors (reducing what's owed) / Cr Purchases + Cr Input GST (reversing expense). */
export async function postDebitNote(client: PgClient, noteId: number, userId: number | null) {
  const { rows: noteRows } = await client.query(
    `select dn.*, v.vendor_name, v.supply_type from debit_notes dn
     join vendors v on v.id = dn.vendor_id where dn.id = $1`,
    [noteId],
  );
  if (noteRows.length === 0) throw new NoteNotFoundError("Debit note", noteId);
  const note = noteRows[0];
  if (note.status !== "draft") throw new NoteNotDraftError("Debit note", noteId, note.status);

  const gst = splitGst(Number(note.gst_amount), note.supply_type as SupplyType);
  const fy = await requireOpenFinancialYear(client, note.note_date.toISOString().slice(0, 10));
  const noteNo = await nextDocumentNumber(client, "debit_note", fy.id);
  const tradeCreditors = await getControlAccountCode("sundry_creditors");

  const lines: PostingLineInput[] = [
    {
      accountCode: tradeCreditors,
      debit: Number(note.total),
      credit: 0,
      narration: `Debit note ${noteNo}`,
      partyType: "vendor",
      partyId: note.vendor_id,
    },
    { accountCode: PURCHASES, debit: 0, credit: Number(note.subtotal), narration: `Debit note ${noteNo}` },
  ];
  if (gst.cgst > 0) lines.push({ accountCode: INPUT_CGST, debit: 0, credit: gst.cgst, narration: `Debit note ${noteNo}` });
  if (gst.sgst > 0) lines.push({ accountCode: INPUT_SGST, debit: 0, credit: gst.sgst, narration: `Debit note ${noteNo}` });
  if (gst.igst > 0) lines.push({ accountCode: INPUT_IGST, debit: 0, credit: gst.igst, narration: `Debit note ${noteNo}` });

  const posted = await postJournalEntry(client, {
    entryDate: note.note_date.toISOString().slice(0, 10),
    narration: `Debit note ${noteNo} — ${note.vendor_name}`,
    sourceType: "debit_note",
    sourceId: note.id,
    lines,
    userId,
  });

  const { rows: updated } = await client.query(
    `update debit_notes set status = 'posted', debit_note_no = $1, journal_entry_id = $2, posted_at = now(), financial_year_id = $4 where id = $3 returning *`,
    [noteNo, posted.id, noteId, fy.id],
  );
  await writeAudit(client, { userId, action: "post", module: "debit_note", recordId: noteId, newValue: { noteNo, journalEntryId: posted.id } });
  return updated[0];
}
