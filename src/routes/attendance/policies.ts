import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("attendance.master.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from attendance_policies order by policy_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("attendance.master.manage"), asyncHandler(async (req: Request, res: Response) => {
  const {
    policyCode, policyName, graceMinutes, halfDayThresholdHours, fullDayThresholdHours,
    overtimeEnabled, overtimeThresholdMinutes, minOvertimeMinutes,
  } = req.body ?? {};
  if (!policyCode || !policyName) return res.status(400).json({ error: "policyCode and policyName are required." });
  if (halfDayThresholdHours != null && fullDayThresholdHours != null && Number(halfDayThresholdHours) >= Number(fullDayThresholdHours)) {
    return res.status(422).json({ error: "halfDayThresholdHours must be less than fullDayThresholdHours." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into attendance_policies (policy_code, policy_name, grace_minutes, half_day_threshold_hours, full_day_threshold_hours, overtime_enabled, overtime_threshold_minutes, min_overtime_minutes)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [
          policyCode, policyName, graceMinutes ?? 0, halfDayThresholdHours ?? 4.0, fullDayThresholdHours ?? 8.0,
          overtimeEnabled ?? false, overtimeThresholdMinutes ?? 0, minOvertimeMinutes ?? 30,
        ],
      );
      const record = rows[0];
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "attendance_policies", recordId: record.id, newValue: record });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: `Policy code "${policyCode}" already exists.` });
    if ((err as { code?: string }).code === "23514") return res.status(422).json({ error: "halfDayThresholdHours must be less than fullDayThresholdHours." });
    throw err;
  }
}));

router.patch("/:id", requirePermission("attendance.master.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const {
    policyName, graceMinutes, halfDayThresholdHours, fullDayThresholdHours,
    overtimeEnabled, overtimeThresholdMinutes, minOvertimeMinutes,
  } = req.body ?? {};

  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`select * from attendance_policies where id = $1`, [id]);
      if (existing.length === 0) return null;

      const { rows } = await client.query(
        `update attendance_policies set
           policy_name = coalesce($2, policy_name),
           grace_minutes = coalesce($3, grace_minutes),
           half_day_threshold_hours = coalesce($4, half_day_threshold_hours),
           full_day_threshold_hours = coalesce($5, full_day_threshold_hours),
           overtime_enabled = coalesce($6, overtime_enabled),
           overtime_threshold_minutes = coalesce($7, overtime_threshold_minutes),
           min_overtime_minutes = coalesce($8, min_overtime_minutes),
           updated_at = now()
         where id = $1 returning *`,
        [id, policyName ?? null, graceMinutes ?? null, halfDayThresholdHours ?? null, fullDayThresholdHours ?? null, overtimeEnabled ?? null, overtimeThresholdMinutes ?? null, minOvertimeMinutes ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "attendance_policies", recordId: id, oldValue: existing[0], newValue: rows[0] });
      return rows[0];
    });
    if (!result) return res.status(404).json({ error: "Attendance policy not found." });
    return res.status(200).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23514") return res.status(422).json({ error: "halfDayThresholdHours must be less than fullDayThresholdHours." });
    throw err;
  }
}));

router.post("/:id/deactivate", requirePermission("attendance.master.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`select * from attendance_policies where id = $1`, [id]);
      if (existing.length === 0) return null;
      if (existing[0].policy_code === "DEFAULT") throw new SystemPolicyError();

      const { rows } = await client.query(`update attendance_policies set is_active = false, updated_at = now() where id = $1 returning *`, [id]);
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "deactivate", module: "attendance_policies", recordId: id, oldValue: existing[0], newValue: rows[0] });
      return rows[0];
    });
    if (!result) return res.status(404).json({ error: "Attendance policy not found." });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof SystemPolicyError) return res.status(409).json({ error: err.message });
    throw err;
  }
}));

class SystemPolicyError extends Error {
  constructor() { super("The DEFAULT policy is a system fallback and cannot be deactivated."); this.name = "SystemPolicyError"; }
}

export default router;
