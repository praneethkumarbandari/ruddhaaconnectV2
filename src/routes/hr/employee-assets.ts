import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

/** Mounted at /api/hr/employees/:employeeId/assets (mergeParams). */
const router = Router({ mergeParams: true });

router.get("/", requirePermission("hr.employee_asset.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_assets where employee_id = $1 order by issued_date desc`, [req.params.employeeId]);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.employee_asset.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { assetName, assetCode, issuedDate, conditionNotes } = req.body ?? {};
  if (!assetName || !issuedDate) return res.status(400).json({ error: "assetName and issuedDate are required." });

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into employee_assets (employee_id, asset_name, asset_code, issued_date, condition_notes)
         values ($1,$2,$3,$4,$5) returning *`,
        [employeeId, assetName, assetCode ?? null, issuedDate, conditionNotes ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "employee_assets", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23503") return res.status(404).json({ error: "Employee not found." });
    throw err;
  }
}));

router.post("/:assetId/return", requirePermission("hr.employee_asset.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { returnedDate, conditionNotes } = req.body ?? {};
  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`select * from employee_assets where id = $1 and employee_id = $2`, [req.params.assetId, req.params.employeeId]);
      if (existing.length === 0) return null;

      const { rows } = await client.query(
        `update employee_assets set returned_date = $2, condition_notes = coalesce($3, condition_notes) where id = $1 returning *`,
        [req.params.assetId, returnedDate ?? new Date().toISOString().slice(0, 10), conditionNotes ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_assets", recordId: Number(req.params.assetId), oldValue: existing[0], newValue: rows[0] });
      return rows[0];
    });
    if (!result) return res.status(404).json({ error: "Asset assignment not found." });
    return res.status(200).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23514") return res.status(400).json({ error: "returnedDate cannot be before issuedDate." });
    throw err;
  }
}));

export default router;
