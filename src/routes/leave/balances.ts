import { Router, type Request, type Response } from "express";
import { withTransaction } from "../../db/pool.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { getLeaveBalance, postLeaveBalanceTransaction, runAccrualBatch, getLeaveYearForDate, LeavePolicyNotFoundError } from "../../lib/leave-balance.ts";

const router = Router();

router.get("/", requirePermission("leave.balance.view"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.query.employeeId);
  const leaveTypeId = Number(req.query.leaveTypeId);
  const leaveYear = req.query.leaveYear ? Number(req.query.leaveYear) : null;
  if (!employeeId || !leaveTypeId) return res.status(400).json({ error: "employeeId and leaveTypeId are required." });

  const year = leaveYear ?? (await withTransaction((client) => getLeaveYearForDate(client, new Date().toISOString().slice(0, 10))));
  const balance = await withTransaction((client) => getLeaveBalance(client, employeeId, leaveTypeId, year));
  return res.status(200).json({ employeeId, leaveTypeId, leaveYear: year, balance });
}));

router.get("/my", requirePermission("leave.apply"), asyncHandler(async (req: Request, res: Response) => {
  const leaveTypeId = Number(req.query.leaveTypeId);
  if (!leaveTypeId) return res.status(400).json({ error: "leaveTypeId is required." });
  const leaveYear = req.query.leaveYear ? Number(req.query.leaveYear) : await withTransaction((client) => getLeaveYearForDate(client, new Date().toISOString().slice(0, 10)));
  const balance = await withTransaction((client) => getLeaveBalance(client, req.user!.userId, leaveTypeId, leaveYear));
  return res.status(200).json({ employeeId: req.user!.userId, leaveTypeId, leaveYear, balance });
}));

/** Generic ledger post — covers opening balance, encashment, expiry, and manual adjustment. Accrual and carry-forward have their own dedicated endpoints below since they're batch/derived operations, not a single arbitrary entry. */
router.post("/transactions", requirePermission("leave.balance.adjust"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, leaveTypeId, leaveYear, transactionType, days, remarks } = req.body ?? {};
  if (!employeeId || !leaveTypeId || !leaveYear || !transactionType || days == null) {
    return res.status(400).json({ error: "employeeId, leaveTypeId, leaveYear, transactionType, and days are required." });
  }
  if (!["opening_balance", "encashment", "expiry", "manual_adjustment"].includes(transactionType)) {
    return res.status(400).json({ error: "transactionType must be one of: opening_balance, encashment, expiry, manual_adjustment (use /accrue or /carry-forward for those transaction types)." });
  }

  try {
    const result = await withTransaction((client) =>
      postLeaveBalanceTransaction(client, req.user?.userId ?? null, { employeeId, leaveTypeId, leaveYear, transactionType, days: Number(days), referenceType: "manual", remarks }),
    );
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23503") return res.status(400).json({ error: "employeeId or leaveTypeId does not reference an existing record." });
    if ((err as { code?: string }).code === "23514") return res.status(422).json({ error: "days sign is not valid for this transactionType." });
    throw err;
  }
}));

router.post("/accrue", requirePermission("leave.balance.adjust"), asyncHandler(async (req: Request, res: Response) => {
  const { leaveTypeId, leaveYear, periodStart, periodEnd, periodsPerYear, employeeIds } = req.body ?? {};
  if (!leaveTypeId || !leaveYear || !periodStart || !periodEnd || !periodsPerYear) {
    return res.status(400).json({ error: "leaveTypeId, leaveYear, periodStart, periodEnd, and periodsPerYear are required." });
  }
  try {
    const results = await runAccrualBatch(req.user?.userId ?? null, leaveTypeId, leaveYear, periodStart, periodEnd, periodsPerYear, employeeIds);
    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    if (err instanceof LeavePolicyNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

/**
 * Carry-forward: for one employee, moves unused balance from the OLD
 * leave year into the NEW one, capped at leave_types.max_carry_forward_days
 * — anything above the cap is posted as an 'expiry' in the old year
 * rather than silently vanishing (a real, auditable ledger entry for
 * "these days were lost to the cap," not a gap in the history).
 */
router.post("/carry-forward", requirePermission("leave.balance.adjust"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, leaveTypeId, fromLeaveYear, toLeaveYear } = req.body ?? {};
  if (!employeeId || !leaveTypeId || fromLeaveYear == null || toLeaveYear == null) {
    return res.status(400).json({ error: "employeeId, leaveTypeId, fromLeaveYear, and toLeaveYear are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows: policyRows } = await client.query(
        `select lp.*, lt.allow_carry_forward, lt.max_carry_forward_days from leave_policies lp join leave_types lt on lt.id = lp.leave_type_id where lp.leave_type_id = $1`,
        [leaveTypeId],
      );
      if (policyRows.length === 0) throw new LeavePolicyNotFoundError(leaveTypeId);
      const policy = policyRows[0];
      if (!policy.allow_carry_forward) return { carriedForward: 0, expired: 0, message: "This leave type does not allow carry-forward." };

      const balance = await getLeaveBalance(client, employeeId, leaveTypeId, fromLeaveYear);
      if (balance <= 0) return { carriedForward: 0, expired: 0, message: "No unused balance to carry forward." };

      const cap = policy.max_carry_forward_days != null ? Number(policy.max_carry_forward_days) : balance;
      const carried = Math.min(balance, cap);
      const expired = balance - carried;

      await postLeaveBalanceTransaction(client, req.user?.userId ?? null, {
        employeeId, leaveTypeId, leaveYear: fromLeaveYear, transactionType: "expiry", days: -balance,
        referenceType: "system", remarks: `Year-end closing: ${balance} day(s) moved out of ${fromLeaveYear}.`,
      });
      if (carried > 0) {
        await postLeaveBalanceTransaction(client, req.user?.userId ?? null, {
          employeeId, leaveTypeId, leaveYear: toLeaveYear, transactionType: "carry_forward", days: carried,
          referenceType: "system", remarks: `Carried forward from ${fromLeaveYear}${expired > 0 ? ` (${expired} day(s) exceeded the carry-forward cap and expired)` : ""}.`,
        });
      }
      return { carriedForward: carried, expired };
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof LeavePolicyNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

export default router;
