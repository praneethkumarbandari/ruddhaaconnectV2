import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const MAPPING_KEYS = [
  "SALARY_EXPENSE", "EMPLOYER_CONTRIBUTION_EXPENSE", "EMPLOYEE_DEDUCTION_PAYABLE",
  "EMPLOYER_CONTRIBUTION_PAYABLE", "NET_SALARY_PAYABLE", "LOAN_RECEIVABLE",
  "REIMBURSEMENT_EXPENSE", "REIMBURSEMENT_PAYABLE", "BANK_ACCOUNT",
];

const router = Router();

router.get("/", requirePermission("payroll.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from payroll_account_mappings order by mapping_key, component_id, statutory_rule_id`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("payroll.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { mappingKey, componentId, statutoryRuleId, accountCode } = req.body ?? {};
  if (!mappingKey || !accountCode) return res.status(400).json({ error: "mappingKey and accountCode are required." });
  if (!MAPPING_KEYS.includes(mappingKey)) return res.status(400).json({ error: `mappingKey must be one of: ${MAPPING_KEYS.join(", ")}` });
  if (componentId && statutoryRuleId) return res.status(400).json({ error: "A mapping overrides either a component or a statutory rule, not both." });

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into payroll_account_mappings (mapping_key, component_id, statutory_rule_id, account_code)
         values ($1,$2,$3,$4)
         on conflict (mapping_key, component_id, statutory_rule_id) do update set account_code = excluded.account_code, updated_at = now()
         returning *`,
        [mappingKey, componentId ?? null, statutoryRuleId ?? null, accountCode],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "payroll_account_mappings", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23503") return res.status(400).json({ error: "accountCode does not reference an existing, active chart-of-accounts entry, or componentId/statutoryRuleId does not exist." });
    throw err;
  }
}));

router.delete("/:id", requirePermission("payroll.manage"), asyncHandler(async (req: Request, res: Response) => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(`delete from payroll_account_mappings where id = $1 returning *`, [req.params.id]);
    if (rows.length > 0) {
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "payroll_account_mappings", recordId: Number(req.params.id), oldValue: rows[0] });
    }
  });
  return res.status(200).json({ deleted: true });
}));

export default router;
