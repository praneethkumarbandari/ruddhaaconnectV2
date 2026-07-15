import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.shift.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from shifts order by shift_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.shift.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { shiftCode, shiftName, startTime, endTime, breakMinutes } = req.body ?? {};
  if (!shiftCode || !shiftName || !startTime || !endTime) {
    return res.status(400).json({ error: "shiftCode, shiftName, startTime, and endTime are required." });
  }
  if (breakMinutes !== undefined && (typeof breakMinutes !== "number" || breakMinutes < 0)) {
    return res.status(400).json({ error: "breakMinutes must be a non-negative number." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into shifts (shift_code, shift_name, start_time, end_time, break_minutes)
         values ($1, $2, $3, $4, $5) returning *`,
        [shiftCode, shiftName, startTime, endTime, breakMinutes ?? 0],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "shifts",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Shift code "${shiftCode}" already exists.` });
    }
    // Invalid time literal (e.g. "25:99") -> Postgres 22007/22008 -
    // surfaced as 400, not a leaked 500, same discipline as other
    // user-input-shaped Postgres errors in this codebase.
    if ((err as { code?: string }).code === "22007" || (err as { code?: string }).code === "22008") {
      return res.status(400).json({ error: "startTime and endTime must be valid times (HH:MM or HH:MM:SS)." });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.shift.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { shiftName, startTime, endTime, breakMinutes } = req.body ?? {};

  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`select * from shifts where id = $1`, [id]);
      if (existing.length === 0) return null;

      const { rows } = await client.query(
        `update shifts set
           shift_name = coalesce($2, shift_name),
           start_time = coalesce($3, start_time),
           end_time = coalesce($4, end_time),
           break_minutes = coalesce($5, break_minutes),
           updated_at = now()
         where id = $1
         returning *`,
        [id, shiftName ?? null, startTime ?? null, endTime ?? null, breakMinutes ?? null],
      );
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "update",
        module: "shifts",
        recordId: id,
        oldValue: existing[0],
        newValue: rows[0],
      });
      return rows[0];
    });

    if (!result) return res.status(404).json({ error: "Shift not found." });
    return res.status(200).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "22007" || (err as { code?: string }).code === "22008") {
      return res.status(400).json({ error: "startTime and endTime must be valid times (HH:MM or HH:MM:SS)." });
    }
    throw err;
  }
}));

router.post("/:id/deactivate", requirePermission("hr.shift.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from shifts where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update shifts set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "shifts",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Shift not found." });
  return res.status(200).json(result);
}));

export default router;
