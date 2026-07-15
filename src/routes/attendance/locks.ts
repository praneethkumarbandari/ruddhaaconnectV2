import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { lockPeriod, unlockPeriod, listLocks, LockNotFoundError } from "../../lib/attendance-locks.ts";

const router = Router();

router.get("/", requirePermission("attendance.lock.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { lockType, activeOnly } = req.query;
  const rows = await listLocks({ lockType: lockType ? String(lockType) : undefined, activeOnly: activeOnly === "true" });
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("attendance.lock.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { lockType, periodDate } = req.body ?? {};
  if (!lockType || !periodDate) return res.status(400).json({ error: "lockType and periodDate are required." });
  if (!["daily", "monthly"].includes(lockType)) return res.status(400).json({ error: "lockType must be 'daily' or 'monthly'." });

  const result = await lockPeriod(req.user!.userId, lockType, periodDate);
  return res.status(201).json(result);
}));

router.post("/:id/unlock", requirePermission("attendance.lock.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await unlockPeriod(req.user!.userId, Number(req.params.id));
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof LockNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

export default router;
