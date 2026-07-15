import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("attendance.master.view"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId } = req.query;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (employeeId) { params.push(Number(employeeId)); conditions.push(`employee_id = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(`select * from weekly_off_configurations ${where} order by employee_id, day_of_week`, params);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("attendance.master.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, dayOfWeek } = req.body ?? {};
  if (employeeId == null || dayOfWeek == null) return res.status(400).json({ error: "employeeId and dayOfWeek are required." });
  if (dayOfWeek < 0 || dayOfWeek > 6) return res.status(400).json({ error: "dayOfWeek must be between 0 (Sunday) and 6 (Saturday)." });

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into weekly_off_configurations (employee_id, day_of_week) values ($1,$2) returning *`,
        [employeeId, dayOfWeek],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "weekly_off_configurations", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") return res.status(409).json({ error: "This weekly-off day is already configured for this employee." });
    if (code === "23503") return res.status(400).json({ error: "employeeId does not reference an existing employee." });
    throw err;
  }
}));

router.delete("/:id", requirePermission("attendance.master.manage"), asyncHandler(async (req: Request, res: Response) => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(`delete from weekly_off_configurations where id = $1 returning *`, [req.params.id]);
    if (rows.length > 0) {
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "weekly_off_configurations", recordId: Number(req.params.id), oldValue: rows[0] });
    }
  });
  return res.status(200).json({ deleted: true });
}));

export default router;
