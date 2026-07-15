import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.attendance_status.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from attendance_statuses order by status_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.attendance_status.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { statusCode, statusName, isPaid } = req.body ?? {};
  if (!statusCode || !statusName) {
    return res.status(400).json({ error: "statusCode and statusName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into attendance_statuses (status_code, status_name, is_paid)
         values ($1, $2, $3) returning *`,
        [statusCode, statusName, isPaid ?? true],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "attendance_statuses",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Status code "${statusCode}" already exists.` });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.attendance_status.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { statusName, isPaid } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from attendance_statuses where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update attendance_statuses set
         status_name = coalesce($2, status_name),
         is_paid = coalesce($3, is_paid),
         updated_at = now()
       where id = $1
       returning *`,
      [id, statusName ?? null, isPaid ?? null],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "attendance_statuses",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Attendance status not found." });
  return res.status(200).json(result);
}));

router.post("/:id/deactivate", requirePermission("hr.attendance_status.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from attendance_statuses where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update attendance_statuses set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "attendance_statuses",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Attendance status not found." });
  return res.status(200).json(result);
}));

export default router;
