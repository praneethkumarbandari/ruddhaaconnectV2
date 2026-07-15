import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { createDraftSalesInvoice, updateDraftSalesInvoice, postSalesInvoice, cancelSalesInvoice } from "../lib/sales.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import { requirePermission } from "../middleware/permission.ts";
import { renderDocPdf, type CompanyInfo, type DocData } from "../lib/pdf-templates.ts";

const router = Router();
router.use(requirePermission("sales-invoices.view"));

router.get("/:id/pdf", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: headerRows } = await query(
    `select si.*, c.customer_name, c.gstin as customer_gstin, c.address_line1, c.address_line2, c.city, c.state, c.pincode
     from sales_invoices si join customers c on c.id = si.customer_id where si.id = $1`,
    [id],
  );
  if (headerRows.length === 0) return res.status(404).json({ error: "Sales invoice not found." });
  const h = headerRows[0];
  const { rows: lines } = await query(`select * from sales_invoice_lines where sales_invoice_id = $1 order by line_no`, [id]);
  const { rows: configRows } = await query(`select * from portal_config limit 1`);
  const company = (configRows[0] || {}) as CompanyInfo & { pdf_template_style?: string };

  const address = [h.address_line1, h.address_line2, h.city, h.state, h.pincode].filter(Boolean).join(", ");
  const doc: DocData = {
    docType: "Invoice",
    docNo: h.invoice_no,
    docDate: h.invoice_date ? new Date(h.invoice_date).toLocaleDateString("en-IN") : "",
    dueDate: h.due_date ? new Date(h.due_date).toLocaleDateString("en-IN") : null,
    partyLabel: "Bill To",
    partyName: h.customer_name,
    partyGstin: h.customer_gstin,
    partyAddress: address || null,
    lines: lines.map((l: any) => ({ description: l.description, qty: Number(l.qty), rate: Number(l.rate), gst_rate: Number(l.gst_rate), line_amount: Number(l.line_amount) })),
    subtotal: Number(h.subtotal),
    gstAmount: Number(h.gst_amount),
    total: Number(h.total),
    narration: h.narration,
    status: h.status,
  };
  renderDocPdf(res, `invoice-${h.invoice_no || id}`, company, doc, company.pdf_template_style || "classic");
}));

router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.query;
  const where = status ? `where si.status = $1` : "";
  const { rows } = await query(
    `select si.*, c.customer_name from sales_invoices si
     join customers c on c.id = si.customer_id
     ${where}
     order by si.invoice_date desc, si.id desc`,
    status ? [status] : [],
  );
  return res.status(200).json(rows);
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: headerRows } = await query(
    `select si.*, c.customer_name from sales_invoices si join customers c on c.id = si.customer_id where si.id = $1`,
    [id],
  );
  if (headerRows.length === 0) return res.status(404).json({ error: "Sales invoice not found." });
  const { rows: lineRows } = await query(
    `select * from sales_invoice_lines where sales_invoice_id = $1 order by line_no`,
    [id],
  );
  return res.status(200).json({ ...headerRows[0], lines: lineRows });
}));

router.post("/", requirePermission("sales-invoices.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { customerId, invoiceDate, dueDate, lines, narration, projectId } = req.body ?? {};
  if (!customerId || !invoiceDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "customerId, invoiceDate, and a non-empty lines[] are required." });
  }
  const result = await withTransaction((client) =>
    createDraftSalesInvoice(client, {
      customerId,
      invoiceDate,
      dueDate: dueDate || null,
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

/**
 * FIX (Invoice List Actions): the missing Edit path for draft
 * invoices — see updateDraftSalesInvoice()'s own comment in
 * lib/sales.ts. Guarded to draft-only there, not here, so this route
 * and /:id/post share exactly one definition of "editable" rather
 * than two that could drift apart.
 */
router.patch("/:id", requirePermission("sales-invoices.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { customerId, invoiceDate, dueDate, lines, narration, projectId } = req.body ?? {};
  if (!customerId || !invoiceDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "customerId, invoiceDate, and a non-empty lines[] are required." });
  }
  try {
    const result = await withTransaction((client) =>
      updateDraftSalesInvoice(client, Number(req.params.id), {
        customerId,
        invoiceDate,
        dueDate: dueDate || null,
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

router.post("/:id/post", requirePermission("sales-invoices.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) => postSalesInvoice(client, Number(req.params.id), req.user?.userId ?? null));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post(["/:id/reverse", "/:id/cancel"], requirePermission("sales-invoices.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  if (!reason) return res.status(400).json({ error: "reason is required." });
  try {
    const result = await withTransaction((client) => cancelSalesInvoice(client, Number(req.params.id), req.user?.userId ?? null, reason));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

export default router;
