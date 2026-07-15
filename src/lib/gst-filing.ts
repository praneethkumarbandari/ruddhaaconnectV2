import { pool, query } from "../db/pool.ts";
import { gstReport } from "./reports.ts";
import { parseFile } from "./bank-import.ts";

/**
 * Real GST input tax credit set-off, per CBIC Rule 88A (effective
 * since the Feb 2019 amendment). This is a fully-specified, legally
 * mandated sequence — not a policy choice this system invents:
 *
 *   1. IGST credit is utilized against IGST liability FIRST, in full,
 *      before being used anywhere else.
 *   2. Only after IGST liability is fully paid may any REMAINING IGST
 *      credit be applied to CGST and/or SGST liability. The law
 *      permits the taxpayer discretion in what proportion/order to
 *      split remaining IGST credit between CGST and SGST — this
 *      function applies it to CGST first, then SGST, as a stated,
 *      visible convention (see the `note` field in the return value),
 *      not a hidden assumption. A taxpayer who wants the opposite
 *      order can still see the full working below and adjust before
 *      filing.
 *   3. CGST credit must be used against CGST liability first; only
 *      after that is fully paid may any remainder be applied to IGST
 *      liability. CGST credit can NEVER be applied to SGST liability
 *      — this is a hard legal rule, not a simplification.
 *   4. SGST credit works the same way against SGST first, then IGST.
 *      SGST credit can NEVER be applied to CGST liability.
 *   5. Whatever liability remains per head after all of the above is
 *      the actual cash payable for that head — this is the number
 *      that matters for filing, not the aggregate net figure alone.
 *
 * Returns the full working, not just final numbers, specifically so
 * this can be audited line by line rather than trusted blind.
 */
function computeSetOff(
  liability: { igst: number; cgst: number; sgst: number },
  credit: { igst: number; cgst: number; sgst: number },
) {
  let igstLiability = liability.igst, cgstLiability = liability.cgst, sgstLiability = liability.sgst;
  let igstCredit = credit.igst, cgstCredit = credit.cgst, sgstCredit = credit.sgst;
  const working: string[] = [];

  const igstToIgst = Math.min(igstCredit, igstLiability);
  igstLiability -= igstToIgst; igstCredit -= igstToIgst;
  working.push(`IGST credit of ₹${igstToIgst.toFixed(2)} applied to IGST liability first (mandatory).`);

  const igstToCgst = Math.min(igstCredit, cgstLiability);
  cgstLiability -= igstToCgst; igstCredit -= igstToCgst;
  if (igstToCgst > 0) working.push(`Remaining IGST credit of ₹${igstToCgst.toFixed(2)} applied to CGST liability (convention: CGST before SGST).`);
  const igstToSgst = Math.min(igstCredit, sgstLiability);
  sgstLiability -= igstToSgst; igstCredit -= igstToSgst;
  if (igstToSgst > 0) working.push(`Remaining IGST credit of ₹${igstToSgst.toFixed(2)} applied to SGST liability.`);

  const cgstToCgst = Math.min(cgstCredit, cgstLiability);
  cgstLiability -= cgstToCgst; cgstCredit -= cgstToCgst;
  working.push(`CGST credit of ₹${cgstToCgst.toFixed(2)} applied to CGST liability.`);
  const cgstToIgst = Math.min(cgstCredit, igstLiability);
  igstLiability -= cgstToIgst; cgstCredit -= cgstToIgst;
  if (cgstToIgst > 0) working.push(`Remaining CGST credit of ₹${cgstToIgst.toFixed(2)} applied to IGST liability (CGST credit can never offset SGST).`);

  const sgstToSgst = Math.min(sgstCredit, sgstLiability);
  sgstLiability -= sgstToSgst; sgstCredit -= sgstToSgst;
  working.push(`SGST credit of ₹${sgstToSgst.toFixed(2)} applied to SGST liability.`);
  const sgstToIgst = Math.min(sgstCredit, igstLiability);
  igstLiability -= sgstToIgst; sgstCredit -= sgstToIgst;
  if (sgstToIgst > 0) working.push(`Remaining SGST credit of ₹${sgstToIgst.toFixed(2)} applied to IGST liability (SGST credit can never offset CGST).`);

  return {
    totalOutputTax: liability.igst + liability.cgst + liability.sgst,
    totalItcAvailable: credit.igst + credit.cgst + credit.sgst,
    netPayable: (liability.igst + liability.cgst + liability.sgst) - (credit.igst + credit.cgst + credit.sgst),
    cashPayable: {
      igst: Math.max(0, igstLiability),
      cgst: Math.max(0, cgstLiability),
      sgst: Math.max(0, sgstLiability),
    },
    creditCarriedForward: {
      igst: Math.max(0, igstCredit),
      cgst: Math.max(0, cgstCredit),
      sgst: Math.max(0, sgstCredit),
    },
    working,
    note: "Set-off computed per CBIC Rule 88A. Step 2's CGST-before-SGST split of remaining IGST credit is a stated convention where the law permits taxpayer discretion — full working shown above so this can be verified or reordered before filing, not trusted as a black box.",
  };
}

/**
 * GSTR-3B format summary. Reuses gstReport()'s already-correct,
 * CA-reviewed tax split (CGST/SGST/IGST, read from the actual posted
 * GL accounts — the same accounts posting-time logic already decided
 * to use based on each party's real supply_type, netted correctly
 * against credit/debit note reversals) rather than recomputing tax
 * amounts a second, potentially inconsistent way.
 *
 * Taxable value is a separate question gstReport() doesn't answer —
 * it looks only at tax accounts, not the underlying invoice subtotal
 * — computed here directly from sales_invoices/purchase_invoices, net
 * of credit/debit notes against them in the same range.
 *
 * HONEST, STATED LIMITATIONS (fields the real GSTR-3B form has that
 * this cannot populate, because the data to populate them correctly
 * does not exist anywhere in this system — shown as explicit zeros
 * with a note, not silently omitted):
 *   - 3.1(b) Zero-rated (export/SEZ) outward supplies
 *   - 3.1(c) Nil-rated and exempt outward supplies
 *   - 3.1(e) Non-GST outward supplies
 *   - 4(B) ITC reversed
 *   - 4(D) Ineligible ITC (blocked credit categorization)
 *   - 5.1 Interest and late fee
 * None of these have a supply-type/exemption flag anywhere in
 * customers, vendors, or invoice lines — every invoice this system
 * creates is treated as an ordinary taxable supply. If any of these
 * categories are relevant to a real filing, they must be identified
 * and adjusted manually before filing — this report does not, and
 * cannot honestly, claim to detect them.
 */
export async function gstr3bSummary(fromDate: string, toDate: string) {
  const gst = await gstReport(fromDate, toDate);

  const { rows: outwardRows } = await query(
    `select coalesce(sum(si.subtotal), 0) as invoice_subtotal
     from sales_invoices si
     where si.status = 'posted' and si.invoice_date between $1 and $2`,
    [fromDate, toDate],
  );
  const { rows: outwardReturnRows } = await query(
    `select coalesce(sum(cn.subtotal), 0) as return_subtotal
     from credit_notes cn
     where cn.status = 'posted' and cn.note_date between $1 and $2`,
    [fromDate, toDate],
  );
  const outwardTaxableValue = Number(outwardRows[0].invoice_subtotal) - Number(outwardReturnRows[0].return_subtotal);

  const { rows: inwardRows } = await query(
    `select coalesce(sum(pi.subtotal), 0) as invoice_subtotal
     from purchase_invoices pi
     where pi.status = 'posted' and pi.invoice_date between $1 and $2`,
    [fromDate, toDate],
  );
  const { rows: inwardReturnRows } = await query(
    `select coalesce(sum(dn.subtotal), 0) as return_subtotal
     from debit_notes dn
     where dn.status = 'posted' and dn.note_date between $1 and $2`,
    [fromDate, toDate],
  );
  const inwardTaxableValue = Number(inwardRows[0].invoice_subtotal) - Number(inwardReturnRows[0].return_subtotal);

  const findTax = (rows: typeof gst.output, code: string) => {
    const row = rows.find((r) => r.account_code === code);
    return row ? Number(row.total_credit) - Number(row.total_debit) : 0;
  };
  const findInputTax = (rows: typeof gst.input, code: string) => {
    const row = rows.find((r) => r.account_code === code);
    return row ? Number(row.total_debit) - Number(row.total_credit) : 0;
  };

  return {
    section3_1: {
      outwardTaxableSupplies: {
        taxableValue: outwardTaxableValue,
        igst: findTax(gst.output, "2153"),
        cgst: findTax(gst.output, "2151"),
        sgst: findTax(gst.output, "2152"),
      },
      zeroRatedSupplies: { taxableValue: 0, note: "Not tracked — see function-level documentation." },
      nilRatedExemptSupplies: { taxableValue: 0, note: "Not tracked — see function-level documentation." },
      nonGstSupplies: { taxableValue: 0, note: "Not tracked — see function-level documentation." },
    },
    section4_eligibleItc: {
      itcAvailable: {
        taxableValue: inwardTaxableValue,
        igst: findInputTax(gst.input, "1163"),
        cgst: findInputTax(gst.input, "1161"),
        sgst: findInputTax(gst.input, "1162"),
      },
      itcReversed: { amount: 0, note: "Not tracked — see function-level documentation." },
      ineligibleItc: { amount: 0, note: "Not tracked — see function-level documentation." },
    },
    section6_1_paymentOfTax: computeSetOff(
      { igst: findTax(gst.output, "2153"), cgst: findTax(gst.output, "2151"), sgst: findTax(gst.output, "2152") },
      { igst: findInputTax(gst.input, "1163"), cgst: findInputTax(gst.input, "1161"), sgst: findInputTax(gst.input, "1162") },
    ),
  };
}

/**
 * Advances received (GSTR-1 Table 11 equivalent). A receipt's
 * unallocated portion — amount received minus whatever's actually
 * been applied against a specific invoice — is, by definition, money
 * held against future invoicing: an advance. This is derived
 * directly from real data (receipts vs receipt_allocations), not
 * inferred or guessed.
 *
 * HONEST LIMITATION: real GST law requires tax to be paid on advances
 * received for SERVICES (not goods, exempted since Nov 2019 for most
 * taxpayers) at the time of receipt, adjusted later when the actual
 * invoice is raised. This system has no goods-vs-service
 * classification on customers or invoices at all, so it cannot
 * determine whether tax is actually due on any given advance shown
 * here. This function reports the advance AMOUNT accurately; whether
 * GST applies to it is a judgment call for whoever files the return,
 * not something this system can safely decide on its own.
 */
export async function gstAdvancesReceived(fromDate: string, toDate: string) {
  const { rows } = await query(
    `select * from (
       select r.id, r.receipt_no, r.receipt_date, r.amount, c.customer_name, c.gstin, c.supply_type,
         r.amount - coalesce((select sum(ra.allocated_amount) from receipt_allocations ra where ra.receipt_id = r.id), 0) as unallocated_amount
       from receipts r
       join customers c on c.id = r.customer_id
       where r.status = 'posted' and r.receipt_date between $1 and $2
     ) advances
     where unallocated_amount > 0.01
     order by receipt_date`,
    [fromDate, toDate],
  );
  return rows;
}

/**
 * HSN-wise summary (GSTR-1 requirement). Only reflects invoice lines
 * that actually have an HSN code recorded — see
 * schema-invoice-line-hsn.sql for why lines created before that
 * migration have none, honestly, rather than a guessed one. A range
 * spanning pre-fix invoices will show those lines' value inside the
 * "no HSN recorded" bucket, not silently drop them from the totals.
 */
export async function gstHsnSummary(fromDate: string, toDate: string) {
  const { rows } = await query(
    `select
       coalesce(sil.hsn, '(no HSN recorded)') as hsn,
       sum(sil.qty) as total_qty,
       sum(sil.line_amount) as taxable_value,
       sum(round(sil.line_amount * sil.gst_rate / 100, 2)) as tax_amount
     from sales_invoice_lines sil
     join sales_invoices si on si.id = sil.sales_invoice_id
     where si.status = 'posted' and si.invoice_date between $1 and $2
     group by coalesce(sil.hsn, '(no HSN recorded)')
     order by taxable_value desc`,
    [fromDate, toDate],
  );
  return rows;
}

/**
 * B2B vs B2C invoice-wise detail (GSTR-1 requirement). Split purely
 * on whether the customer has a GSTIN on file — a customer with no
 * GSTIN is, by definition, not a registered business for GST
 * purposes, so every invoice to them is B2C regardless of invoice
 * value. No separate "is this customer a business" flag exists or is
 * needed beyond that.
 */
export async function gstInvoiceWiseDetail(fromDate: string, toDate: string) {
  const { rows } = await query(
    `select si.invoice_no, si.invoice_date, si.subtotal, si.gst_amount, si.total,
       c.customer_name, c.gstin, c.supply_type
     from sales_invoices si
     join customers c on c.id = si.customer_id
     where si.status = 'posted' and si.invoice_date between $1 and $2
     order by si.invoice_date, si.invoice_no`,
    [fromDate, toDate],
  );
  return {
    b2b: rows.filter((r) => r.gstin),
    b2c: rows.filter((r) => !r.gstin),
  };
}

/**
 * GSTR-2A/2B reconciliation. There is no live GSTN API integration
 * here — that would require GSTN-issued GSP API credentials this
 * system does not have and cannot fake. What IS real and buildable:
 * comparing an uploaded GSTR-2A/2B export (the file a taxpayer
 * downloads directly from the government portal) against this
 * system's own purchase records, to surface real mismatches before
 * filing — which is the actual point of reconciliation, regardless
 * of whether the comparison happens via a live API call or an
 * uploaded file.
 *
 * Column matching is intentionally flexible (case-insensitive,
 * partial match on key terms) rather than requiring an exact header
 * string, since GSTN's own export format has changed wording between
 * portal versions. If a required column genuinely can't be found,
 * this throws a clear, specific error naming which column is
 * missing, rather than silently proceeding with wrong data.
 */
export async function reconcileGstr2b(buffer: Buffer, originalName: string) {
  const parsed = await parseFile(buffer, originalName);
  const findCol = (...terms: string[]) =>
    parsed.headers.findIndex((h) => terms.some((t) => h.toLowerCase().includes(t)));

  const gstinCol = findCol("gstin");
  const invoiceCol = findCol("invoice number", "invoice no");
  const taxableCol = findCol("taxable value", "taxable amt");
  const igstCol = findCol("integrated tax", "igst");
  const cgstCol = findCol("central tax", "cgst");
  const sgstCol = findCol("state/ut tax", "sgst");

  const missingCols = [
    ["GSTIN", gstinCol], ["Invoice Number", invoiceCol], ["Taxable Value", taxableCol],
  ].filter(([, idx]) => (idx as number) < 0).map(([name]) => name);
  if (missingCols.length > 0) {
    throw new Error(`Could not find required column(s) in the uploaded file: ${missingCols.join(", ")}. Check the file matches the real GSTR-2A/2B export format.`);
  }

  const uploaded = parsed.rows
    .filter((r) => r[gstinCol]?.trim())
    .map((r) => ({
      gstin: r[gstinCol].trim(),
      invoiceNo: r[invoiceCol]?.trim() ?? "",
      taxableValue: Number(r[taxableCol]) || 0,
      igst: igstCol >= 0 ? Number(r[igstCol]) || 0 : 0,
      cgst: cgstCol >= 0 ? Number(r[cgstCol]) || 0 : 0,
      sgst: sgstCol >= 0 ? Number(r[sgstCol]) || 0 : 0,
    }));

  const { rows: ourPurchases } = await query(
    `select pi.vendor_invoice_no, pi.subtotal, pi.gst_amount, v.gstin, v.vendor_name
     from purchase_invoices pi
     join vendors v on v.id = pi.vendor_id
     where pi.status = 'posted' and v.gstin is not null`,
  );

  const matched: unknown[] = [];
  const onlyInGstn: unknown[] = [];
  const usedOurKeys = new Set<string>();

  for (const u of uploaded) {
    const ours = ourPurchases.find((p) => p.gstin === u.gstin && p.vendor_invoice_no?.trim() === u.invoiceNo);
    if (ours) {
      usedOurKeys.add(`${ours.gstin}|${ours.vendor_invoice_no}`);
      const ourTax = Number(ours.gst_amount);
      const gstnTax = u.igst + u.cgst + u.sgst;
      matched.push({
        gstin: u.gstin, invoiceNo: u.invoiceNo, vendorName: ours.vendor_name,
        ourTaxableValue: Number(ours.subtotal), gstnTaxableValue: u.taxableValue,
        ourTax, gstnTax, taxMismatch: Math.abs(ourTax - gstnTax) > 0.5,
      });
    } else {
      onlyInGstn.push({ gstin: u.gstin, invoiceNo: u.invoiceNo, taxableValue: u.taxableValue, tax: u.igst + u.cgst + u.sgst });
    }
  }

  // Real compliance risk: we claimed ITC on a purchase the vendor's
  // own GSTR-2A/2B filing doesn't show at all.
  const onlyInOurBooks = ourPurchases
    .filter((p) => !usedOurKeys.has(`${p.gstin}|${p.vendor_invoice_no?.trim()}`))
    .map((p) => ({ gstin: p.gstin, invoiceNo: p.vendor_invoice_no, vendorName: p.vendor_name, taxableValue: Number(p.subtotal), tax: Number(p.gst_amount) }));

  return { matched, onlyInGstn, onlyInOurBooks };
}
