import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { createDraftReceipt, postReceipt, cancelReceipt, removeReceiptAllocation } from "../lib/receipts.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import { requirePermission } from "../middleware/permission.ts";
import { renderDocPdf, type CompanyInfo, type DocData } from "../lib/pdf-templates.ts";

const router = Router();
router.use(requirePermission("receipts.view"));

router.get("/:id/pdf", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: headerRows } = await query(
    `select r.*, c.customer_name, c.gstin as customer_gstin, c.address_line1, c.address_line2, c.city, c.state, c.pincode
     from receipts r join customers c on c.id = r.customer_id where r.id = $1`,
    [id],
  );
  if (headerRows.length === 0) return res.status(404).json({ error: "Receipt not found." });
  const h = headerRows[0];
  const { rows: configRows } = await query(`select * from portal_config limit 1`);
  const company = (configRows[0] || {}) as CompanyInfo & { pdf_template_style?: string };

  const address = [h.address_line1, h.address_line2, h.city, h.state, h.pincode].filter(Boolean).join(", ");
  const doc: DocData = {
    docType: "Receipt",
    docNo: h.receipt_no,
    docDate: h.receipt_date ? new Date(h.receipt_date).toLocaleDateString("en-IN") : "",
    partyLabel: "Received From",
    partyName: h.customer_name,
    partyGstin: h.customer_gstin,
    partyAddress: address || null,
    amount: Number(h.amount),
    total: Number(h.amount),
    narration: h.narration,
    status: h.status,
  };
  renderDocPdf(res, `receipt-${h.receipt_no || id}`, company, doc, company.pdf_template_style || "classic");
}));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(
    `select r.*, c.customer_name from receipts r join customers c on c.id = r.customer_id order by r.receipt_date desc, r.id desc`,
  );
  return res.status(200).json(rows);
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: headerRows } = await query(
    `select r.*, c.customer_name from receipts r join customers c on c.id = r.customer_id where r.id = $1`,
    [id],
  );
  if (headerRows.length === 0) return res.status(404).json({ error: "Receipt not found." });
  const { rows: allocRows } = await query(
    `select ra.*, si.invoice_no from receipt_allocations ra
     join sales_invoices si on si.id = ra.sales_invoice_id
     where ra.receipt_id = $1`,
    [id],
  );
  return res.status(200).json({ ...headerRows[0], allocations: allocRows });
}));

router.post("/", requirePermission("receipts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { customerId, receiptDate, amount, bankAccountCode, allocations, narration, projectId } = req.body ?? {};
  if (!customerId || !receiptDate || !amount || !bankAccountCode) {
    return res.status(400).json({ error: "customerId, receiptDate, amount, and bankAccountCode are required." });
  }
  try {
    const result = await withTransaction((client) =>
      createDraftReceipt(client, {
        customerId,
        receiptDate,
        amount: Number(amount),
        bankAccountCode,
        allocations: Array.isArray(allocations)
          ? allocations.map((a: { salesInvoiceId: number; allocatedAmount: number }) => ({
              salesInvoiceId: a.salesInvoiceId,
              allocatedAmount: Number(a.allocatedAmount),
            }))
          : [],
        narration,
        userId: req.user?.userId ?? null,
        projectId: projectId != null ? Number(projectId) : null,
      }),
    );
    return res.status(201).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/:id/post", requirePermission("receipts.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) => postReceipt(client, Number(req.params.id), req.user?.userId ?? null));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.delete("/:id/allocations/:salesInvoiceId", requirePermission("receipts.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) =>
      removeReceiptAllocation(client, Number(req.params.id), Number(req.params.salesInvoiceId), req.user?.userId ?? null),
    );
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

// FIX (voucher terminology consistency): standardizing on "reverse"
// as the one term for this action across every voucher type — Journal
// Entry and Contra already used it, Receipts/Payments/Invoices said
// "cancel" for the exact same underlying mechanism (an equal-and-
// opposite entry via reverseJournalEntry(), never a deletion). /cancel
// is kept as a backward-compatible alias to the same handler rather
// than removed outright, in case any existing caller isn't updated yet.
router.post(["/:id/reverse", "/:id/cancel"], requirePermission("receipts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  if (!reason) return res.status(400).json({ error: "reason is required." });
  try {
    const result = await withTransaction((client) => cancelReceipt(client, Number(req.params.id), req.user?.userId ?? null, reason));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

export default router;
