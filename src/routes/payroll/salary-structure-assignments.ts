import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId } = req.query;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (employeeId) { params.push(Number(employeeId)); conditions.push(`essa.employee_id = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(
    `select essa.*, ss.structure_code, ss.structure_name from employee_salary_structure_assignments essa
     join salary_structures ss on ss.id = essa.structure_id ${where} order by essa.employee_id, essa.effective_from desc`,
    params,
  );
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("payroll.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, structureId, effectiveFrom, effectiveTo } = req.body ?? {};
  if (!employeeId || !structureId || !effectiveFrom) {
    return res.status(400).json({ error: "employeeId, structureId, and effectiveFrom are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into employee_salary_structure_assignments (employee_id, structure_id, effective_from, effective_to, created_by)
         values ($1,$2,$3,$4,$5) returning *`,
        [employeeId, structureId, effectiveFrom, effectiveTo ?? null, req.user?.userId ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "employee_salary_structure_assignments", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23503") return res.status(400).json({ error: "employeeId or structureId does not reference an existing record." });
    if (code === "23P01") return res.status(409).json({ error: "This date range overlaps an existing salary structure assignment for this employee." });
    throw err;
  }
}));

export default router;
