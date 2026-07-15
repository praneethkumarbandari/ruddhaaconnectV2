import PDFDocument from "pdfkit";
import type { Response } from "express";

/**
 * Shared PDF rendering for Invoices, Receipts, and Payments.
 *
 * Chose pdfkit (pure JavaScript, draws the PDF directly) over
 * something like Puppeteer/headless Chrome deliberately: this backend
 * runs as Netlify Functions, and shipping a full Chromium binary into
 * a serverless function is fragile (large package size, cold-start
 * cost, platform compatibility issues) compared to a pure-JS library
 * with no external binary dependency at all.
 *
 * Three styles, matching what a business picks in Settings
 * (portal_config.pdf_template_style): 'classic', 'modern', 'minimal'.
 * They differ in visual treatment only — every style renders the
 * exact same data, just laid out differently — so switching styles
 * later never changes what information appears.
 */

export type CompanyInfo = {
  company_name: string | null;
  logo_path: string | null;
  address: string | null;
  gst_number: string | null;
  support_phone: string | null;
  support_email: string | null;
  website: string | null;
};

export type DocLine = {
  description: string;
  qty: number;
  rate: number;
  gst_rate?: number;
  line_amount: number;
};

export type DocData = {
  docType: "Invoice" | "Receipt" | "Payment";
  docNo: string | null;
  docDate: string;
  dueDate?: string | null;
  partyLabel: string; // "Bill To" / "Received From" / "Paid To"
  partyName: string;
  partyGstin?: string | null;
  partyAddress?: string | null;
  lines?: DocLine[]; // Invoices only
  amount?: number; // Receipts/Payments — single amount, no lines
  subtotal?: number;
  gstAmount?: number;
  total: number;
  narration?: string | null;
  status: string;
};

const COLORS = {
  classic: { primary: "#1f2937", accent: "#1f6bff", line: "#d1d5db" },
  modern: { primary: "#0f172a", accent: "#7c3aed", line: "#e2e8f0" },
  minimal: { primary: "#111111", accent: "#111111", line: "#eeeeee" },
};

function fmtMoney(n: number | undefined | null): string {
  const v = Number(n || 0);
  return "Rs. " + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function drawHeader(doc: PDFKit.PDFDocument, company: CompanyInfo, doc_: DocData, style: string, c: typeof COLORS.classic) {
  const startY = doc.y;
  doc.fillColor(c.primary).fontSize(20).font("Helvetica-Bold").text(company.company_name || "Your Business", 50, startY);
  doc.fontSize(9).font("Helvetica").fillColor("#555");
  if (company.address) doc.text(company.address, 50, doc.y + 4, { width: 280 });
  if (company.gst_number) doc.text("GSTIN: " + company.gst_number, 50);
  if (company.support_phone || company.support_email) {
    doc.text([company.support_phone, company.support_email].filter(Boolean).join("  |  "), 50);
  }

  doc.fillColor(c.accent).fontSize(18).font("Helvetica-Bold")
    .text(doc_.docType.toUpperCase(), 350, startY, { width: 200, align: "right" });
  doc.fontSize(10).font("Helvetica").fillColor("#333");
  if (doc_.docNo) doc.text(doc_.docNo, 350, doc.y + 2, { width: 200, align: "right" });
  doc.text("Date: " + doc_.docDate, 350, doc.y, { width: 200, align: "right" });
  if (doc_.dueDate) doc.text("Due: " + doc_.dueDate, 350, doc.y, { width: 200, align: "right" });
  doc.text("Status: " + doc_.status.toUpperCase(), 350, doc.y, { width: 200, align: "right" });

  doc.moveDown(2);
  doc.strokeColor(c.line).lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);
}

function drawParty(doc: PDFKit.PDFDocument, d: DocData, c: typeof COLORS.classic) {
  doc.fillColor(c.accent).fontSize(10).font("Helvetica-Bold").text(d.partyLabel.toUpperCase());
  doc.fillColor("#111").fontSize(12).font("Helvetica-Bold").text(d.partyName);
  doc.fontSize(9).font("Helvetica").fillColor("#555");
  if (d.partyGstin) doc.text("GSTIN: " + d.partyGstin);
  if (d.partyAddress) doc.text(d.partyAddress, { width: 300 });
  doc.moveDown(1.5);
}

function drawLinesTable(doc: PDFKit.PDFDocument, lines: DocLine[], c: typeof COLORS.classic) {
  const colX = { desc: 50, qty: 300, rate: 360, gst: 430, amt: 480 };
  doc.fillColor("#fff").rect(50, doc.y, 495, 22).fill(c.accent);
  doc.fillColor("#fff").fontSize(9).font("Helvetica-Bold");
  const headerY = doc.y - 16;
  doc.text("DESCRIPTION", colX.desc + 6, headerY);
  doc.text("QTY", colX.qty, headerY, { width: 50, align: "right" });
  doc.text("RATE", colX.rate, headerY, { width: 60, align: "right" });
  doc.text("GST%", colX.gst, headerY, { width: 45, align: "right" });
  doc.text("AMOUNT", colX.amt, headerY, { width: 60, align: "right" });
  doc.moveDown(1.2);

  doc.font("Helvetica").fontSize(9);
  lines.forEach((l, i) => {
    const y = doc.y;
    if (i % 2 === 1) doc.rect(50, y - 2, 495, 18).fill("#f8f9fb");
    doc.fillColor("#333");
    doc.text(l.description, colX.desc + 6, y, { width: 240 });
    doc.text(String(l.qty), colX.qty, y, { width: 50, align: "right" });
    doc.text(fmtMoney(l.rate), colX.rate, y, { width: 60, align: "right" });
    doc.text((l.gst_rate || 0) + "%", colX.gst, y, { width: 45, align: "right" });
    doc.text(fmtMoney(l.line_amount), colX.amt, y, { width: 60, align: "right" });
    doc.moveDown(1.1);
  });
  doc.strokeColor(c.line).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);
}

function drawTotals(doc: PDFKit.PDFDocument, d: DocData, c: typeof COLORS.classic) {
  const rowX = 380, valX = 480;
  doc.font("Helvetica").fontSize(9).fillColor("#333");
  if (d.subtotal != null) {
    doc.text("Subtotal", rowX, doc.y, { width: 90 });
    doc.text(fmtMoney(d.subtotal), valX, doc.y - 11, { width: 65, align: "right" });
  }
  if (d.gstAmount != null) {
    doc.text("GST", rowX, doc.y, { width: 90 });
    doc.text(fmtMoney(d.gstAmount), valX, doc.y - 11, { width: 65, align: "right" });
  }
  doc.moveDown(0.3);
  doc.strokeColor(c.line).moveTo(rowX, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(c.accent);
  doc.text("TOTAL", rowX, doc.y, { width: 90 });
  doc.text(fmtMoney(d.total), valX, doc.y - 14, { width: 65, align: "right" });
  doc.moveDown(1.5);
}

function drawFooter(doc: PDFKit.PDFDocument, d: DocData, company: CompanyInfo, c: typeof COLORS.classic) {
  if (d.narration) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555").text("Notes");
    doc.font("Helvetica").fontSize(9).fillColor("#333").text(d.narration, { width: 495 });
    doc.moveDown(1);
  }
  doc.strokeColor(c.line).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor("#999").font("Helvetica")
    .text("This is a system-generated document" + (company.website ? " — " + company.website : "") + ".", 50, doc.y, { width: 495, align: "center" });
}

export function renderDocPdf(res: Response, filename: string, company: CompanyInfo, d: DocData, style: string) {
  const c = COLORS[(style as keyof typeof COLORS)] || COLORS.classic;
  const doc = new PDFDocument({ size: "A4", margin: 50 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, company, d, style, c);
  drawParty(doc, d, c);

  if (d.lines && d.lines.length) {
    drawLinesTable(doc, d.lines, c);
  } else if (d.amount != null) {
    doc.font("Helvetica").fontSize(11).fillColor("#333")
      .text("Amount: " + fmtMoney(d.amount), { align: "right" });
    doc.moveDown(1);
  }

  drawTotals(doc, d, c);
  drawFooter(doc, d, company, c);

  doc.end();
}
