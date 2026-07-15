import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { createDraftPayment, postPayment, cancelPayment, removePaymentAllocation } from "../lib/payments.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import { requirePermission } from "../middleware/permission.ts";
import { renderDocPdf, type CompanyInfo, type DocData } from "../lib/pdf-templates.ts";

const router = Router();
router.use(requirePermission("payments.view"));

router.get("/:id/pdf", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: headerRows } = await query(
    `select p.*, v.vendor_name, v.gstin as vendor_gstin, v.address_line1, v.address_line2, v.city, v.state, v.pincode
     from payments p join vendors v on v.id = p.vendor_id where p.id = $1`,
    [id],
  );
  if (headerRows.length === 0) return res.status(404).json({ error: "Payment not found." });
  const h = headerRows[0];
  const { rows: configRows } = await query(`select * from portal_config limit 1`);
  const company = (configRows[0] || {}) as CompanyInfo & { pdf_template_style?: string };

  const address = [h.address_line1, h.address_line2, h.city, h.state, h.pincode].filter(Boolean).join(", ");
  const doc: DocData = {
    docType: "Payment",
    docNo: h.payment_no,
    docDate: h.payment_date ? new Date(h.payment_date).toLocaleDateString("en-IN") : "",
    partyLabel: "Paid To",
    partyName: h.vendor_name,
    partyGstin: h.vendor_gstin,
    partyAddress: address || null,
    amount: Number(h.amount),
    total: Number(h.amount),
    narration: h.narration,
    status: h.status,
  };
  renderDocPdf(res, `payment-${h.payment_no || id}`, company, doc, company.pdf_template_style || "classic");
}));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(
    `select p.*, v.vendor_name from payments p join vendors v on v.id = p.vendor_id order by p.payment_date desc, p.id desc`,
  );
  return res.status(200).json(rows);
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: headerRows } = await query(
    `select p.*, v.vendor_name from payments p join vendors v on v.id = p.vendor_id where p.id = $1`,
    [id],
  );
  if (headerRows.length === 0) return res.status(404).json({ error: "Payment not found." });
  const { rows: allocRows } = await query(
    `select pa.*, pi.purchase_no from payment_allocations pa
     join purchase_invoices pi on pi.id = pa.purchase_invoice_id
     where pa.payment_id = $1`,
    [id],
  );
  return res.status(200).json({ ...headerRows[0], allocations: allocRows });
}));

router.post("/", requirePermission("payments.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { vendorId, paymentDate, amount, bankAccountCode, allocations, narration, projectId, tdsSectionId } = req.body ?? {};
  if (!vendorId || !paymentDate || !amount || !bankAccountCode) {
    return res.status(400).json({ error: "vendorId, paymentDate, amount, and bankAccountCode are required." });
  }
  try {
    const result = await withTransaction((client) =>
      createDraftPayment(client, {
        vendorId,
        paymentDate,
        amount: Number(amount),
        bankAccountCode,
        allocations: Array.isArray(allocations)
          ? allocations.map((a: { purchaseInvoiceId: number; allocatedAmount: number }) => ({
              purchaseInvoiceId: a.purchaseInvoiceId,
              allocatedAmount: Number(a.allocatedAmount),
            }))
          : [],
        narration,
        userId: req.user?.userId ?? null,
        projectId: projectId != null ? Number(projectId) : null,
        tdsSectionId: tdsSectionId != null ? Number(tdsSectionId) : null,
      }),
    );
    return res.status(201).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/:id/post", requirePermission("payments.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) => postPayment(client, Number(req.params.id), req.user?.userId ?? null));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.delete("/:id/allocations/:purchaseInvoiceId", requirePermission("payments.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) =>
      removePaymentAllocation(client, Number(req.params.id), Number(req.params.purchaseInvoiceId), req.user?.userId ?? null),
    );
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post(["/:id/reverse", "/:id/cancel"], requirePermission("payments.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  if (!reason) return res.status(400).json({ error: "reason is required." });
  try {
    const result = await withTransaction((client) => cancelPayment(client, Number(req.params.id), req.user?.userId ?? null, reason));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

export default router;
