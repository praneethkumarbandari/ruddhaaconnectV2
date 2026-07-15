import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();
const COMPONENT_TYPES = ["earning", "deduction"];
const CALCULATION_TYPES = ["fixed", "percentage", "formula"];

router.get("/", requirePermission("hr.salary_component.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from salary_components order by component_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.salary_component.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { componentCode, componentName, componentType, calculationType, isTaxable, affectsNetPay } = req.body ?? {};
  if (!componentCode || !componentName || !componentType || !calculationType) {
    return res.status(400).json({ error: "componentCode, componentName, componentType, and calculationType are required." });
  }
  if (!COMPONENT_TYPES.includes(componentType)) {
    return res.status(400).json({ error: `componentType must be one of: ${COMPONENT_TYPES.join(", ")}` });
  }
  if (!CALCULATION_TYPES.includes(calculationType)) {
    return res.status(400).json({ error: `calculationType must be one of: ${CALCULATION_TYPES.join(", ")}` });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into salary_components (component_code, component_name, component_type, calculation_type, is_taxable, affects_net_pay)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [componentCode, componentName, componentType, calculationType, isTaxable ?? true, affectsNetPay ?? true],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "salary_components",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Component code "${componentCode}" already exists.` });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.salary_component.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { componentName, isTaxable, affectsNetPay } = req.body ?? {};
  // componentType and calculationType are deliberately not editable
  // here: changing either after a salary_structure_component already
  // references this row would silently change how existing structures
  // behave. Deactivate and create a replacement component instead.

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from salary_components where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update salary_components set
         component_name = coalesce($2, component_name),
         is_taxable = coalesce($3, is_taxable),
         affects_net_pay = coalesce($4, affects_net_pay),
         updated_at = now()
       where id = $1
       returning *`,
      [id, componentName ?? null, isTaxable ?? null, affectsNetPay ?? null],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "salary_components",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Salary component not found." });
  return res.status(200).json(result);
}));

router.post("/:id/deactivate", requirePermission("hr.salary_component.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from salary_components where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update salary_components set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "salary_components",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Salary component not found." });
  return res.status(200).json(result);
}));

export default router;
