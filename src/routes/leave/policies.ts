import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("leave.policy.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(
    `select lp.*, lt.leave_type_code, lt.leave_type_name from leave_policies lp join leave_types lt on lt.id = lp.leave_type_id order by lt.leave_type_code`,
  );
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("leave.policy.manage"), asyncHandler(async (req: Request, res: Response) => {
  const {
    leaveTypeId, requiresBalanceCheck, halfDayEnabled, maxConsecutiveDays, sandwichRuleEnabled,
    countHolidaysAsLeave, probationPeriodDays, allowDuringProbation, noticePeriodRestricted,
    carryForwardExpiryMonths, encashmentRate, maxEncashableDays,
  } = req.body ?? {};
  if (!leaveTypeId) return res.status(400).json({ error: "leaveTypeId is required." });

  try {
    const result = await withTransaction(async (client) => {
      const { rows: leaveType } = await client.query(`select 1 from leave_types where id = $1`, [leaveTypeId]);
      if (leaveType.length === 0) throw new LeaveTypeNotFoundError(leaveTypeId);

      const { rows } = await client.query(
        `insert into leave_policies (
           leave_type_id, requires_balance_check, half_day_enabled, max_consecutive_days, sandwich_rule_enabled,
           count_holidays_as_leave, probation_period_days, allow_during_probation, notice_period_restricted,
           carry_forward_expiry_months, encashment_rate, max_encashable_days
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [
          leaveTypeId, requiresBalanceCheck ?? true, halfDayEnabled ?? true, maxConsecutiveDays ?? null, sandwichRuleEnabled ?? false,
          countHolidaysAsLeave ?? false, probationPeriodDays ?? 0, allowDuringProbation ?? true, noticePeriodRestricted ?? false,
          carryForwardExpiryMonths ?? null, encashmentRate ?? 1.0, maxEncashableDays ?? null,
        ],
      );
      const record = rows[0];
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "leave_policies", recordId: record.id, newValue: record });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof LeaveTypeNotFoundError) return res.status(400).json({ error: err.message });
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "A leave policy already exists for this leave type — update it instead of creating a second one." });
    if ((err as { code?: string }).code === "23514") return res.status(422).json({ error: "maxConsecutiveDays must be greater than zero if provided." });
    throw err;
  }
}));

router.patch("/:id", requirePermission("leave.policy.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const {
    requiresBalanceCheck, halfDayEnabled, maxConsecutiveDays, sandwichRuleEnabled,
    countHolidaysAsLeave, probationPeriodDays, allowDuringProbation, noticePeriodRestricted,
    carryForwardExpiryMonths, encashmentRate, maxEncashableDays,
  } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from leave_policies where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update leave_policies set
         requires_balance_check = coalesce($2, requires_balance_check),
         half_day_enabled = coalesce($3, half_day_enabled),
         max_consecutive_days = $4,
         sandwich_rule_enabled = coalesce($5, sandwich_rule_enabled),
         count_holidays_as_leave = coalesce($6, count_holidays_as_leave),
         probation_period_days = coalesce($7, probation_period_days),
         allow_during_probation = coalesce($8, allow_during_probation),
         notice_period_restricted = coalesce($9, notice_period_restricted),
         carry_forward_expiry_months = $10,
         encashment_rate = coalesce($11, encashment_rate),
         max_encashable_days = $12,
         updated_at = now()
       where id = $1 returning *`,
      [
        id, requiresBalanceCheck ?? null, halfDayEnabled ?? null,
        "maxConsecutiveDays" in (req.body ?? {}) ? maxConsecutiveDays : existing[0].max_consecutive_days,
        sandwichRuleEnabled ?? null, countHolidaysAsLeave ?? null, probationPeriodDays ?? null, allowDuringProbation ?? null,
        noticePeriodRestricted ?? null,
        "carryForwardExpiryMonths" in (req.body ?? {}) ? carryForwardExpiryMonths : existing[0].carry_forward_expiry_months,
        encashmentRate ?? null,
        "maxEncashableDays" in (req.body ?? {}) ? maxEncashableDays : existing[0].max_encashable_days,
      ],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "leave_policies", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Leave policy not found." });
  return res.status(200).json(result);
}));

class LeaveTypeNotFoundError extends Error {
  constructor(id: number) { super(`leaveTypeId ${id} does not reference an existing leave type.`); this.name = "LeaveTypeNotFoundError"; }
}

export default router;
