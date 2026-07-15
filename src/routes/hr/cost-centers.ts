import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.cost_center.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from cost_centers order by cost_center_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.cost_center.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { costCenterCode, costCenterName, departmentId } = req.body ?? {};
  if (!costCenterCode || !costCenterName) {
    return res.status(400).json({ error: "costCenterCode and costCenterName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into cost_centers (cost_center_code, cost_center_name, department_id)
         values ($1, $2, $3) returning *`,
        [costCenterCode, costCenterName, departmentId ?? null],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "cost_centers",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Cost center code "${costCenterCode}" already exists.` });
    }
    if ((err as { code?: string }).code === "23503") {
      return res.status(400).json({ error: "departmentId does not reference an existing department." });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.cost_center.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { costCenterName, departmentId } = req.body ?? {};

  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`select * from cost_centers where id = $1`, [id]);
      if (existing.length === 0) return null;

      const { rows } = await client.query(
        `update cost_centers set
           cost_center_name = coalesce($2, cost_center_name),
           department_id = $3,
           updated_at = now()
         where id = $1
         returning *`,
        [id, costCenterName ?? null, departmentId ?? existing[0].department_id],
      );
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "update",
        module: "cost_centers",
        recordId: id,
        oldValue: existing[0],
        newValue: rows[0],
      });
      return rows[0];
    });

    if (!result) return res.status(404).json({ error: "Cost center not found." });
    return res.status(200).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23503") {
      return res.status(400).json({ error: "departmentId does not reference an existing department." });
    }
    throw err;
  }
}));

router.post("/:id/deactivate", requirePermission("hr.cost_center.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from cost_centers where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update cost_centers set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "cost_centers",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Cost center not found." });
  return res.status(200).json(result);
}));

export default router;
