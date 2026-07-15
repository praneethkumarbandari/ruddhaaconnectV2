import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { createDraftCreditNote, postCreditNote, cancelCreditNote, createDraftDebitNote, postDebitNote, cancelDebitNote } from "../lib/notes.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import { requirePermission } from "../middleware/permission.ts";

const creditNoteRouter = Router();
const debitNoteRouter = Router();
creditNoteRouter.use(requirePermission("credit-notes.view"));
debitNoteRouter.use(requirePermission("debit-notes.view"));

creditNoteRouter.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(
    `select cn.*, c.customer_name from credit_notes cn join customers c on c.id = cn.customer_id order by cn.note_date desc, cn.id desc`,
  );
  return res.status(200).json(rows);
}));

creditNoteRouter.post("/", requirePermission("credit-notes.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { customerId, againstInvoiceId, noteDate, lines, narration, projectId } = req.body ?? {};
  if (!customerId || !noteDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "customerId, noteDate, and a non-empty lines[] are required." });
  }
  const result = await withTransaction((client) =>
    createDraftCreditNote(client, {
      customerId,
      againstInvoiceId,
      noteDate,
      lines: lines.map((l: { description: string; qty: number; rate: number; gstRate?: number }) => ({
        description: l.description, qty: Number(l.qty), rate: Number(l.rate), gstRate: Number(l.gstRate) || 0,
      })),
      narration,
      userId: req.user?.userId ?? null,
      projectId: projectId != null ? Number(projectId) : null,
    }),
  );
  return res.status(201).json(result);
}));

creditNoteRouter.post("/:id/post", requirePermission("credit-notes.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) => postCreditNote(client, Number(req.params.id), req.user?.userId ?? null));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

creditNoteRouter.post(["/:id/reverse", "/:id/cancel"], requirePermission("credit-notes.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  if (!reason) return res.status(400).json({ error: "reason is required." });
  try {
    const result = await withTransaction((client) => cancelCreditNote(client, Number(req.params.id), req.user?.userId ?? null, reason));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

debitNoteRouter.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(
    `select dn.*, v.vendor_name from debit_notes dn join vendors v on v.id = dn.vendor_id order by dn.note_date desc, dn.id desc`,
  );
  return res.status(200).json(rows);
}));

debitNoteRouter.post("/", requirePermission("debit-notes.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { vendorId, againstInvoiceId, noteDate, lines, narration, projectId } = req.body ?? {};
  if (!vendorId || !noteDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "vendorId, noteDate, and a non-empty lines[] are required." });
  }
  const result = await withTransaction((client) =>
    createDraftDebitNote(client, {
      vendorId,
      againstInvoiceId,
      noteDate,
      lines: lines.map((l: { description: string; qty: number; rate: number; gstRate?: number }) => ({
        description: l.description, qty: Number(l.qty), rate: Number(l.rate), gstRate: Number(l.gstRate) || 0,
      })),
      narration,
      userId: req.user?.userId ?? null,
      projectId: projectId != null ? Number(projectId) : null,
    }),
  );
  return res.status(201).json(result);
}));

debitNoteRouter.post("/:id/post", requirePermission("debit-notes.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) => postDebitNote(client, Number(req.params.id), req.user?.userId ?? null));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

debitNoteRouter.post(["/:id/reverse", "/:id/cancel"], requirePermission("debit-notes.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  if (!reason) return res.status(400).json({ error: "reason is required." });
  try {
    const result = await withTransaction((client) => cancelDebitNote(client, Number(req.params.id), req.user?.userId ?? null, reason));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

export { creditNoteRouter, debitNoteRouter };
