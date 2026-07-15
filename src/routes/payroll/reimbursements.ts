import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import {
  createClaim, approveClaim, rejectClaim, cancelClaim, getClaim, listClaims,
  ClaimNotFoundError, ClaimNotPendingError, NotEntitledClaimApproverError, NotOwnClaimError,
} from "../../lib/payroll-reimbursements.ts";

const router = Router();

function mapClaimError(err: unknown, res: Response): boolean {
  if (err instanceof ClaimNotFoundError) { res.status(404).json({ error: err.message }); return true; }
  if (err instanceof ClaimNotPendingError) { res.status(422).json({ error: err.message }); return true; }
  if (err instanceof NotEntitledClaimApproverError || err instanceof NotOwnClaimError) { res.status(403).json({ error: err.message }); return true; }
  return false;
}

router.post("/", requirePermission("payroll.reimbursement.claim"), asyncHandler(async (req: Request, res: Response) => {
  const { claimType, amount, isTaxable, claimDate, description } = req.body ?? {};
  if (!claimType || !amount || !claimDate) return res.status(400).json({ error: "claimType, amount, and claimDate are required." });
  const result = await createClaim(req.user!.userId, { employeeId: req.user!.userId, claimType, amount, isTaxable: isTaxable ?? false, claimDate, description });
  return res.status(201).json(result);
}));

router.get("/my", requirePermission("payroll.reimbursement.claim"), asyncHandler(async (req: Request, res: Response) => {
  const rows = await listClaims({ employeeId: req.user!.userId });
  return res.status(200).json(rows);
}));

router.post("/:id/cancel", requirePermission("payroll.reimbursement.claim"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await cancelClaim(req.user!.userId, Number(req.params.id));
    return res.status(200).json(result);
  } catch (err) {
    if (mapClaimError(err, res)) return;
    throw err;
  }
}));

router.get("/", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, status } = req.query;
  const rows = await listClaims({ employeeId: employeeId ? Number(employeeId) : undefined, status: status ? String(status) : undefined });
  return res.status(200).json(rows);
}));

router.get("/:id", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const claim = await getClaim(Number(req.params.id));
    return res.status(200).json(claim);
  } catch (err) {
    if (mapClaimError(err, res)) return;
    throw err;
  }
}));

router.post("/:id/approve", requirePermission("payroll.approve"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await approveClaim(req.user!.userId, Number(req.params.id));
    return res.status(200).json(result);
  } catch (err) {
    if (mapClaimError(err, res)) return;
    throw err;
  }
}));

router.post("/:id/reject", requirePermission("payroll.approve"), asyncHandler(async (req: Request, res: Response) => {
  const { decisionNotes } = req.body ?? {};
  try {
    const result = await rejectClaim(req.user!.userId, Number(req.params.id), decisionNotes ?? null);
    return res.status(200).json(result);
  } catch (err) {
    if (mapClaimError(err, res)) return;
    throw err;
  }
}));

export default router;
