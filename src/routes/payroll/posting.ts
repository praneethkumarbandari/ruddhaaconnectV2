import { Router, type Request, type Response } from "express";
import { withTransaction } from "../../db/pool.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { postPayrollAccrual, postPayrollPayment, PayrollAlreadyPaidError } from "../../lib/payroll-accounting.ts";
import { journalPostingPreview } from "../../lib/payroll-reports.ts";
import { PayrollRunNotLockedError } from "../../lib/payroll-runs.ts";
import { UnbalancedEntryError, UnknownAccountError, InsufficientLinesError } from "../../lib/posting-engine.ts";
import { AccountMappingNotFoundError } from "../../lib/payroll-accounts.ts";

const router = Router();

function mapPostingError(err: unknown, res: Response): boolean {
  if (err instanceof PayrollRunNotLockedError) { res.status(422).json({ error: err.message }); return true; }
  if (err instanceof AccountMappingNotFoundError) { res.status(422).json({ error: err.message }); return true; }
  if (err instanceof UnbalancedEntryError || err instanceof InsufficientLinesError || err instanceof UnknownAccountError) {
    // Surfacing postJournalEntry()'s own validation errors directly —
    // if this ever fires, it means the accrual-building arithmetic in
    // lib/payroll-accounting.ts has a real bug, and the existing
    // posting engine caught it before anything was written. This
    // should never happen in practice (see the balance proof in that
    // file's comments) but is not swallowed if it does.
    res.status(422).json({ error: `Posting engine rejected this entry: ${err.message}` });
    return true;
  }
  if (err instanceof PayrollAlreadyPaidError) { res.status(409).json({ error: err.message }); return true; }
  return false;
}

router.get("/:runId/preview", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await journalPostingPreview(Number(req.params.runId));
    return res.status(200).json(result);
  } catch (err) {
    if (mapPostingError(err, res)) return;
    throw err;
  }
}));

router.post("/:runId/post", requirePermission("payroll.post"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) => postPayrollAccrual(client, req.user!.userId, Number(req.params.runId)));
    return res.status(200).json(result);
  } catch (err) {
    if (mapPostingError(err, res)) return;
    throw err;
  }
}));

router.post("/:runId/pay", requirePermission("payroll.post"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) => postPayrollPayment(client, req.user!.userId, Number(req.params.runId)));
    return res.status(200).json(result);
  } catch (err) {
    if (mapPostingError(err, res)) return;
    throw err;
  }
}));

export default router;
