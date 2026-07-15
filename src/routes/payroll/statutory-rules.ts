import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("payroll.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from statutory_rules order by rule_code`);
  return res.status(200).json(rows);
}));

router.get("/:id", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows: rule } = await query(`select * from statutory_rules where id = $1`, [req.params.id]);
  if (rule.length === 0) return res.status(404).json({ error: "Statutory rule not found." });
  const { rows: slabs } = await query(`select * from statutory_rule_slabs where statutory_rule_id = $1 order by slab_from`, [req.params.id]);
  return res.status(200).json({ ...rule[0], slabs });
}));

router.post("/", requirePermission("payroll.manage"), asyncHandler(async (req: Request, res: Response) => {
  const {
    ruleCode, ruleName, calculationType, wageBasis, rate, fixedAmount, wageCeiling, eligibilityCeiling,
    employeeSharePercentage, employerSharePercentage, effectiveFrom,
  } = req.body ?? {};
  if (!ruleCode || !ruleName || !calculationType) {
    return res.status(400).json({ error: "ruleCode, ruleName, and calculationType are required." });
  }
  if (calculationType === "percentage" && rate == null) return res.status(400).json({ error: "rate is required for calculationType 'percentage'." });
  if (calculationType === "fixed" && fixedAmount == null) return res.status(400).json({ error: "fixedAmount is required for calculationType 'fixed'." });

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into statutory_rules (rule_code, rule_name, calculation_type, wage_basis, rate, fixed_amount, wage_ceiling, eligibility_ceiling, employee_share_percentage, employer_share_percentage, effective_from)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11, current_date)) returning *`,
        [ruleCode, ruleName, calculationType, wageBasis ?? "basic", rate ?? null, fixedAmount ?? null, wageCeiling ?? null, eligibilityCeiling ?? null, employeeSharePercentage ?? 100, employerSharePercentage ?? 0, effectiveFrom ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "statutory_rules", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: `Rule code "${ruleCode}" already exists.` });
    throw err;
  }
}));

router.patch("/:id", requirePermission("payroll.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { ruleName, rate, fixedAmount, wageCeiling, eligibilityCeiling, employeeSharePercentage, employerSharePercentage, isActive } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from statutory_rules where id = $1`, [id]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(
      `update statutory_rules set
         rule_name = coalesce($2, rule_name), rate = coalesce($3, rate), fixed_amount = coalesce($4, fixed_amount),
         wage_ceiling = $5, eligibility_ceiling = $6, employee_share_percentage = coalesce($7, employee_share_percentage),
         employer_share_percentage = coalesce($8, employer_share_percentage), is_active = coalesce($9, is_active), updated_at = now()
       where id = $1 returning *`,
      [id, ruleName ?? null, rate ?? null, fixedAmount ?? null,
       "wageCeiling" in (req.body ?? {}) ? wageCeiling : existing[0].wage_ceiling,
       "eligibilityCeiling" in (req.body ?? {}) ? eligibilityCeiling : existing[0].eligibility_ceiling,
       employeeSharePercentage ?? null, employerSharePercentage ?? null, isActive ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "statutory_rules", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
  if (!result) return res.status(404).json({ error: "Statutory rule not found." });
  return res.status(200).json(result);
}));

router.post("/:id/slabs", requirePermission("payroll.manage"), asyncHandler(async (req: Request, res: Response) => {
  const ruleId = Number(req.params.id);
  const { slabFrom, slabTo, rate } = req.body ?? {};
  if (slabFrom == null || rate == null) return res.status(400).json({ error: "slabFrom and rate are required." });

  try {
    const result = await withTransaction(async (client) => {
      const { rows: rule } = await client.query(`select 1 from statutory_rules where id = $1`, [ruleId]);
      if (rule.length === 0) throw new Error("RULE_NOT_FOUND");
      const { rows } = await client.query(
        `insert into statutory_rule_slabs (statutory_rule_id, slab_from, slab_to, rate) values ($1,$2,$3,$4) returning *`,
        [ruleId, slabFrom, slabTo ?? null, rate],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "statutory_rule_slabs", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof Error && err.message === "RULE_NOT_FOUND") return res.status(404).json({ error: "Statutory rule not found." });
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "A slab already starts at this slabFrom for this rule." });
    throw err;
  }
}));

export default router;
