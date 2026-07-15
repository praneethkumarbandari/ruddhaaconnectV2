import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("leave.policy.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from leave_year_configurations where is_active = true limit 1`);
  return res.status(200).json(rows[0] ?? null);
}));

/**
 * PUT, not POST: this is a singleton (the single active leave-year
 * config), not a growing collection — replacing "the" configuration
 * is the correct verb, not creating a new resource alongside others.
 * Deactivates any previously-active row rather than deleting it, so
 * a change in leave-year convention is itself auditable history, not
 * silently destroyed.
 */
router.put("/", requirePermission("leave.policy.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { startMonth, startDay } = req.body ?? {};
  if (!startMonth) return res.status(400).json({ error: "startMonth is required." });
  if (startMonth < 1 || startMonth > 12) return res.status(400).json({ error: "startMonth must be between 1 and 12." });

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from leave_year_configurations where is_active = true`);
    await client.query(`update leave_year_configurations set is_active = false where is_active = true`);

    const { rows } = await client.query(
      `insert into leave_year_configurations (start_month, start_day) values ($1, $2) returning *`,
      [startMonth, startDay ?? 1],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "leave_year_configurations", recordId: rows[0].id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });

  return res.status(200).json(result);
}));

export default router;
