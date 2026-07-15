import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { assertNotLocked, AttendanceLockedError } from "../../lib/attendance-locks.ts";

const router = Router();

router.get("/", requirePermission("attendance.master.view"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId } = req.query;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (employeeId) { params.push(Number(employeeId)); conditions.push(`employee_id = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(`select * from shift_overrides ${where} order by override_date desc`, params);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("attendance.master.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, overrideDate, shiftId, reason } = req.body ?? {};
  if (!employeeId || !overrideDate || !shiftId) {
    return res.status(400).json({ error: "employeeId, overrideDate, and shiftId are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      // Overrides for an already-locked date are blocked, same as
      // any other attendance-affecting write — a shift swap on a
      // locked date would silently change how that day's (already
      // finalized) hours are interpreted if recalculated.
      await assertNotLocked(client, overrideDate);

      const { rows } = await client.query(
        `insert into shift_overrides (employee_id, override_date, shift_id, reason, created_by)
         values ($1,$2,$3,$4,$5)
         on conflict (employee_id, override_date) do update set shift_id = excluded.shift_id, reason = excluded.reason
         returning *`,
        [employeeId, overrideDate, shiftId, reason ?? null, req.user?.userId ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "shift_overrides", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof AttendanceLockedError) return res.status(409).json({ error: err.message });
    if ((err as { code?: string }).code === "23503") return res.status(400).json({ error: "employeeId or shiftId does not reference an existing record." });
    throw err;
  }
}));

export default router;
