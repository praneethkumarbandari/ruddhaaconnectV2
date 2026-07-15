export type SupplyType = "intrastate" | "interstate";

export type GstSplit = {
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Splits a total GST amount according to supply type. Intrastate
 * splits evenly into CGST + SGST (half each); interstate goes
 * entirely to IGST. This is the one place that decision is made —
 * every caller (sales, purchases, credit/debit notes) uses this
 * instead of re-implementing the split.
 */
export function splitGst(gstAmount: number, supplyType: SupplyType): GstSplit {
  if (supplyType === "interstate") {
    return { cgst: 0, sgst: 0, igst: round2(gstAmount), total: round2(gstAmount) };
  }
  const half = round2(gstAmount / 2);
  // Put any 1-paise rounding remainder on SGST rather than dropping it,
  // so cgst + sgst always reconciles exactly to the input gstAmount.
  const sgst = round2(gstAmount - half);
  return { cgst: half, sgst, igst: 0, total: round2(gstAmount) };
}

/** Computes subtotal and GST amount for a set of invoice-style lines. */
export function computeLineTotals(lines: Array<{ qty: number; rate: number; gstRate: number }>) {
  let subtotal = 0;
  let gstAmount = 0;
  for (const line of lines) {
    const lineAmount = round2(line.qty * line.rate);
    subtotal = round2(subtotal + lineAmount);
    gstAmount = round2(gstAmount + round2(lineAmount * (line.gstRate / 100)));
  }
  return { subtotal, gstAmount, total: round2(subtotal + gstAmount) };
}
