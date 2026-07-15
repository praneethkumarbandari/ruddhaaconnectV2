import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { getShiftForDate } from "../../lib/attendance-processing.ts";

const router = Router();

router.get("/", requirePermission("attendance.master.view"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId } = req.query;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (employeeId) { params.push(Number(employeeId)); conditions.push(`esa.employee_id = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(
    `select esa.*, s.shift_code, s.shift_name
     from employee_shift_assignments esa
     join shifts s on s.id = esa.shift_id
     ${where}
     order by esa.employee_id, esa.effective_from desc`,
    params,
  );
  return res.status(200).json(rows);
}));

router.get("/current", requirePermission("attendance.master.view"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.query.employeeId);
  const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
  if (!employeeId) return res.status(400).json({ error: "employeeId is required." });

  const result = await withTransaction((client) => getShiftForDate(client, employeeId, date));
  return res.status(200).json(result);
}));

router.post("/", requirePermission("attendance.master.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, shiftId, effectiveFrom, effectiveTo } = req.body ?? {};
  if (!employeeId || !shiftId || !effectiveFrom) {
    return res.status(400).json({ error: "employeeId, shiftId, and effectiveFrom are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into employee_shift_assignments (employee_id, shift_id, effective_from, effective_to, created_by)
         values ($1,$2,$3,$4,$5) returning *`,
        [employeeId, shiftId, effectiveFrom, effectiveTo ?? null, req.user?.userId ?? null],
      );
      const record = rows[0];
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "employee_shift_assignments", recordId: record.id, newValue: record });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23503") return res.status(400).json({ error: "employeeId or shiftId does not reference an existing record." });
    if (code === "23P01") return res.status(409).json({ error: "This date range overlaps an existing shift assignment for this employee." });
    throw err;
  }
}));

export default router;
