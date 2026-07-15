import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();
const ACCRUAL_FREQUENCIES = ["monthly", "yearly", "none"];

router.get("/", requirePermission("hr.leave_type.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from leave_types order by leave_type_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.leave_type.manage"), asyncHandler(async (req: Request, res: Response) => {
  const {
    leaveTypeCode, leaveTypeName, accrualFrequency,
    defaultAnnualDays, allowCarryForward, maxCarryForwardDays, allowEncashment,
  } = req.body ?? {};
  if (!leaveTypeCode || !leaveTypeName) {
    return res.status(400).json({ error: "leaveTypeCode and leaveTypeName are required." });
  }
  const frequency = accrualFrequency ?? "yearly";
  if (!ACCRUAL_FREQUENCIES.includes(frequency)) {
    return res.status(400).json({ error: `accrualFrequency must be one of: ${ACCRUAL_FREQUENCIES.join(", ")}` });
  }
  if (allowCarryForward && maxCarryForwardDays == null) {
    return res.status(400).json({ error: "maxCarryForwardDays is required when allowCarryForward is true." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into leave_types (leave_type_code, leave_type_name, accrual_frequency, default_annual_days, allow_carry_forward, max_carry_forward_days, allow_encashment)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [
          leaveTypeCode, leaveTypeName, frequency,
          defaultAnnualDays ?? 0, allowCarryForward ?? false, maxCarryForwardDays ?? null, allowEncashment ?? false,
        ],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "leave_types",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Leave type code "${leaveTypeCode}" already exists.` });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.leave_type.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const {
    leaveTypeName, defaultAnnualDays, allowCarryForward, maxCarryForwardDays, allowEncashment,
  } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from leave_types where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update leave_types set
         leave_type_name = coalesce($2, leave_type_name),
         default_annual_days = coalesce($3, default_annual_days),
         allow_carry_forward = coalesce($4, allow_carry_forward),
         max_carry_forward_days = coalesce($5, max_carry_forward_days),
         allow_encashment = coalesce($6, allow_encashment),
         updated_at = now()
       where id = $1
       returning *`,
      [id, leaveTypeName ?? null, defaultAnnualDays ?? null, allowCarryForward ?? null, maxCarryForwardDays ?? null, allowEncashment ?? null],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "leave_types",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Leave type not found." });
  return res.status(200).json(result);
}));

router.post("/:id/deactivate", requirePermission("hr.leave_type.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from leave_types where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update leave_types set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "leave_types",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Leave type not found." });
  return res.status(200).json(result);
}));

export default router;
