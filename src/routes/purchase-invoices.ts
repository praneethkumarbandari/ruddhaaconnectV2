import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { createDraftPurchaseInvoice, updateDraftPurchaseInvoice, postPurchaseInvoice, cancelPurchaseInvoice } from "../lib/purchases.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import { requirePermission } from "../middleware/permission.ts";
import { renderDocPdf, type CompanyInfo, type DocData } from "../lib/pdf-templates.ts";

const router = Router();
router.use(requirePermission("purchase-invoices.view"));

router.get("/:id/pdf", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: headerRows } = await query(
    `select pi.*, v.vendor_name, v.gstin as vendor_gstin, v.address_line1, v.address_line2, v.city, v.state, v.pincode
     from purchase_invoices pi join vendors v on v.id = pi.vendor_id where pi.id = $1`,
    [id],
  );
  if (headerRows.length === 0) return res.status(404).json({ error: "Purchase invoice not found." });
  const h = headerRows[0];
  const { rows: lines } = await query(`select * from purchase_invoice_lines where purchase_invoice_id = $1 order by line_no`, [id]);
  const { rows: configRows } = await query(`select * from portal_config limit 1`);
  const company = (configRows[0] || {}) as CompanyInfo & { pdf_template_style?: string };

  const address = [h.address_line1, h.address_line2, h.city, h.state, h.pincode].filter(Boolean).join(", ");
  const doc: DocData = {
    docType: "Invoice",
    docNo: h.vendor_invoice_no || h.id,
    docDate: h.invoice_date ? new Date(h.invoice_date).toLocaleDateString("en-IN") : "",
    dueDate: h.due_date ? new Date(h.due_date).toLocaleDateString("en-IN") : null,
    partyLabel: "Vendor",
    partyName: h.vendor_name,
    partyGstin: h.vendor_gstin,
    partyAddress: address || null,
    lines: lines.map((l: any) => ({ description: l.description, qty: Number(l.qty), rate: Number(l.rate), gst_rate: Number(l.gst_rate), line_amount: Number(l.line_amount) })),
    subtotal: Number(h.subtotal),
    gstAmount: Number(h.gst_amount),
    total: Number(h.total),
    narration: h.narration,
    status: h.status,
  };
  renderDocPdf(res, `purchase-invoice-${h.id}`, company, doc, company.pdf_template_style || "classic");
}));

router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.query;
  const where = status ? `where pi.status = $1` : "";
  const { rows } = await query(
    `select pi.*, v.vendor_name from purchase_invoices pi
     join vendors v on v.id = pi.vendor_id
     ${where}
     order by pi.invoice_date desc, pi.id desc`,
    status ? [status] : [],
  );
  return res.status(200).json(rows);
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: headerRows } = await query(
    `select pi.*, v.vendor_name from purchase_invoices pi join vendors v on v.id = pi.vendor_id where pi.id = $1`,
    [id],
  );
  if (headerRows.length === 0) return res.status(404).json({ error: "Purchase invoice not found." });
  const { rows: lineRows } = await query(
    `select * from purchase_invoice_lines where purchase_invoice_id = $1 order by line_no`,
    [id],
  );
  return res.status(200).json({ ...headerRows[0], lines: lineRows });
}));

router.post("/", requirePermission("purchase-invoices.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { vendorId, invoiceDate, dueDate, vendorInvoiceNo, lines, narration, projectId } = req.body ?? {};
  if (!vendorId || !invoiceDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "vendorId, invoiceDate, and a non-empty lines[] are required." });
  }
  const result = await withTransaction((client) =>
    createDraftPurchaseInvoice(client, {
      vendorId,
      invoiceDate,
      dueDate: dueDate || null,
      vendorInvoiceNo,
      lines: lines.map((l: { description: string; qty: number; rate: number; gstRate?: number; hsn?: string; itemId?: number }) => ({
        description: l.description,
        qty: Number(l.qty),
        rate: Number(l.rate),
        gstRate: Number(l.gstRate) || 0,
        hsn: l.hsn ?? null,
        itemId: l.itemId != null ? Number(l.itemId) : null,
      })),
      narration,
      userId: req.user?.userId ?? null,
      projectId: projectId != null ? Number(projectId) : null,
    }),
  );
  return res.status(201).json(result);
}));

/** See the identical fix in routes/sales-invoices.ts — same reasoning, mirrored for purchases. */
router.patch("/:id", requirePermission("purchase-invoices.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { vendorId, invoiceDate, dueDate, vendorInvoiceNo, lines, narration, projectId } = req.body ?? {};
  if (!vendorId || !invoiceDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "vendorId, invoiceDate, and a non-empty lines[] are required." });
  }
  try {
    const result = await withTransaction((client) =>
      updateDraftPurchaseInvoice(client, Number(req.params.id), {
        vendorId,
        invoiceDate,
        dueDate: dueDate || null,
        vendorInvoiceNo,
        lines: lines.map((l: { description: string; qty: number; rate: number; gstRate?: number; hsn?: string; itemId?: number }) => ({
          description: l.description,
          qty: Number(l.qty),
          rate: Number(l.rate),
          gstRate: Number(l.gstRate) || 0,
          hsn: l.hsn ?? null,
          itemId: l.itemId != null ? Number(l.itemId) : null,
        })),
        narration,
        userId: req.user?.userId ?? null,
        projectId: projectId != null ? Number(projectId) : null,
      }),
    );
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/:id/post", requirePermission("purchase-invoices.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) => postPurchaseInvoice(client, Number(req.params.id), req.user?.userId ?? null));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post(["/:id/reverse", "/:id/cancel"], requirePermission("purchase-invoices.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  if (!reason) return res.status(400).json({ error: "reason is required." });
  try {
    const result = await withTransaction((client) => cancelPurchaseInvoice(client, Number(req.params.id), req.user?.userId ?? null, reason));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

export default router;
