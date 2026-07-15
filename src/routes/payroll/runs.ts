import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import {
  createPayrollRun, processPayrollRun, lockPayrollRun, unlockPayrollRun, getPayrollRun, listPayrollRuns,
  PayrollRunNotFoundError, PayrollRunLockedError, PayrollRunNotProcessedError, PayrollRunNotLockedError,
  PayrollRunAlreadyPostedError, OverlappingPayrollRunError,
} from "../../lib/payroll-runs.ts";

const router = Router();

function mapRunError(err: unknown, res: Response): boolean {
  if (err instanceof PayrollRunNotFoundError) { res.status(404).json({ error: err.message }); return true; }
  if (
    err instanceof PayrollRunLockedError || err instanceof PayrollRunNotProcessedError ||
    err instanceof PayrollRunNotLockedError || err instanceof PayrollRunAlreadyPostedError
  ) { res.status(422).json({ error: err.message }); return true; }
  if (err instanceof OverlappingPayrollRunError) { res.status(409).json({ error: err.message }); return true; }
  return false;
}

router.get("/", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const { status, runType } = req.query;
  const rows = await listPayrollRuns({ status: status ? String(status) : undefined, runType: runType ? String(runType) : undefined });
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("payroll.process"), asyncHandler(async (req: Request, res: Response) => {
  const { runType, periodStart, periodEnd, branchId } = req.body ?? {};
  if (!runType || !periodStart || !periodEnd) return res.status(400).json({ error: "runType, periodStart, and periodEnd are required." });
  try {
    const result = await createPayrollRun(req.user?.userId ?? null, { runType, periodStart, periodEnd, branchId });
    return res.status(201).json(result);
  } catch (err) {
    if (mapRunError(err, res)) return;
    throw err;
  }
}));

router.get("/:id", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await getPayrollRun(Number(req.params.id));
    return res.status(200).json(result);
  } catch (err) {
    if (mapRunError(err, res)) return;
    throw err;
  }
}));

/** "Reprocessing before lock": calling this again on a 'processed' run recomputes every eligible employee's line from current data. */
router.post("/:id/process", requirePermission("payroll.process"), asyncHandler(async (req: Request, res: Response) => {
  const { manualAdjustments } = req.body ?? {};
  try {
    const result = await processPayrollRun(req.user?.userId ?? null, Number(req.params.id), manualAdjustments ?? {});
    return res.status(200).json(result);
  } catch (err) {
    if (mapRunError(err, res)) return;
    throw err;
  }
}));

router.post("/:id/lock", requirePermission("payroll.lock"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await lockPayrollRun(req.user!.userId, Number(req.params.id));
    return res.status(200).json(result);
  } catch (err) {
    if (mapRunError(err, res)) return;
    throw err;
  }
}));

/** "Payroll Re-open (authorized users only)" — payroll.unlock is a separate, stricter permission than payroll.lock/payroll.process. */
router.post("/:id/unlock", requirePermission("payroll.unlock"), asyncHandler(async (req: Request, res: Response) => {
  const { reopenReason } = req.body ?? {};
  if (!reopenReason) return res.status(400).json({ error: "reopenReason is required." });
  try {
    const result = await unlockPayrollRun(req.user!.userId, Number(req.params.id), reopenReason);
    return res.status(200).json(result);
  } catch (err) {
    if (mapRunError(err, res)) return;
    throw err;
  }
}));

export default router;
