import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "../lib/audit.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("payments.view"));

router.get("/sections", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from tds_sections order by section_code`);
  return res.status(200).json(rows);
}));

router.post("/sections", requirePermission("payments.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { sectionCode, sectionName, ratePercentage, thresholdSinglePayment, thresholdAggregateAnnual } = req.body ?? {};
  if (!sectionCode || !sectionName || ratePercentage == null) {
    return res.status(400).json({ error: "sectionCode, sectionName, and ratePercentage are required." });
  }
  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into tds_sections (section_code, section_name, rate_percentage, threshold_single_payment, threshold_aggregate_annual)
         values ($1,$2,$3,$4,$5) returning *`,
        [sectionCode, sectionName, ratePercentage, thresholdSinglePayment ?? null, thresholdAggregateAnnual ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "tds_sections", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: `Section code "${sectionCode}" already exists.` });
    throw err;
  }
}));

router.patch("/sections/:id", requirePermission("payments.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { sectionName, ratePercentage, thresholdSinglePayment, thresholdAggregateAnnual, isActive } = req.body ?? {};
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from tds_sections where id = $1`, [id]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(
      `update tds_sections set
         section_name = coalesce($2, section_name), rate_percentage = coalesce($3, rate_percentage),
         threshold_single_payment = $4, threshold_aggregate_annual = $5, is_active = coalesce($6, is_active)
       where id = $1 returning *`,
      [id, sectionName ?? null, ratePercentage ?? null,
       "thresholdSinglePayment" in (req.body ?? {}) ? thresholdSinglePayment : existing[0].threshold_single_payment,
       "thresholdAggregateAnnual" in (req.body ?? {}) ? thresholdAggregateAnnual : existing[0].threshold_aggregate_annual,
       isActive ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "tds_sections", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
  if (!result) return res.status(404).json({ error: "TDS section not found." });
  return res.status(200).json(result);
}));

/** TDS deduction register — the raw source of truth for both Form 16A and 26Q below. */
router.get("/register", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate, vendorId } = req.query as Record<string, string>;
  if (!fromDate || !toDate) return res.status(400).json({ error: "fromDate and toDate are required." });
  const conditions = ["td.deduction_date between $1 and $2"];
  const params: unknown[] = [fromDate, toDate];
  if (vendorId) { params.push(Number(vendorId)); conditions.push(`td.vendor_id = $${params.length}`); }
  const { rows } = await query(
    `select td.*, v.vendor_name, v.pan, v.gstin, ts.section_code, ts.section_name, p.payment_no
     from tds_deductions td
     join vendors v on v.id = td.vendor_id
     join tds_sections ts on ts.id = td.tds_section_id
     join payments p on p.id = td.payment_id
     where ${conditions.join(" and ")}
     order by td.deduction_date`,
    params,
  );
  return res.status(200).json(rows);
}));

/**
 * Form 16A summary — per vendor, per quarter, aggregated. This is the
 * data a real Form 16A certificate is built from; it is NOT the
 * official government-prescribed PDF format (which requires TRACES
 * portal generation and a digital signature this system has no way
 * to produce) — it's an accurate internal summary a business can use
 * to prepare that certificate, not a substitute for actually issuing
 * one through TRACES.
 */
router.get("/form16a-summary", asyncHandler(async (req: Request, res: Response) => {
  const { financialYearId, quarter, vendorId } = req.query as Record<string, string>;
  if (!financialYearId || !quarter) return res.status(400).json({ error: "financialYearId and quarter are required." });
  const conditions = ["td.financial_year_id = $1", "td.quarter = $2", "td.reversed_at is null"];
  const params: unknown[] = [Number(financialYearId), Number(quarter)];
  if (vendorId) { params.push(Number(vendorId)); conditions.push(`td.vendor_id = $${params.length}`); }
  const { rows } = await query(
    `select v.id as vendor_id, v.vendor_name, v.pan, ts.section_code, ts.section_name,
       sum(td.gross_amount) as total_gross_amount, sum(td.tds_amount) as total_tds_amount, count(*) as deduction_count
     from tds_deductions td
     join vendors v on v.id = td.vendor_id
     join tds_sections ts on ts.id = td.tds_section_id
     where ${conditions.join(" and ")}
     group by v.id, v.vendor_name, v.pan, ts.section_code, ts.section_name
     order by v.vendor_name`,
    params,
  );
  return res.status(200).json(rows);
}));

/**
 * 26Q summary — quarterly return, deductee-wise. Same honest caveat
 * as Form 16A: this is the real, correct underlying data in the
 * shape 26Q needs, not an actual e-filed return (that requires TAN-
 * based TRACES/income tax portal API access this system does not
 * have and cannot fake).
 */
router.get("/26q-summary", asyncHandler(async (req: Request, res: Response) => {
  const { financialYearId, quarter } = req.query as Record<string, string>;
  if (!financialYearId || !quarter) return res.status(400).json({ error: "financialYearId and quarter are required." });
  const { rows } = await query(
    `select v.vendor_name, v.pan, ts.section_code, sum(td.gross_amount) as total_gross_amount, sum(td.tds_amount) as total_tds_amount
     from tds_deductions td
     join vendors v on v.id = td.vendor_id
     join tds_sections ts on ts.id = td.tds_section_id
     where td.financial_year_id = $1 and td.quarter = $2 and td.reversed_at is null
     group by v.vendor_name, v.pan, ts.section_code
     order by ts.section_code, v.vendor_name`,
    [Number(financialYearId), Number(quarter)],
  );
  const missingPan = rows.filter((r) => !r.pan);
  return res.status(200).json({
    rows,
    missingPanWarning: missingPan.length > 0
      ? `${missingPan.length} deductee(s) have no PAN on file — a real 26Q filing requires PAN for every deductee (or a flat 20% rate applies under Section 206AA). Add PAN before filing.`
      : null,
  });
}));

export default router;
