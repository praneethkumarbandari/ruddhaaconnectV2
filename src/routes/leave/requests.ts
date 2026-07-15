import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { handleDomainError } from "../../lib/error-mapping.ts";
import {
  createLeaveRequest, approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
  getLeaveRequest, listLeaveRequests, listMyPendingApprovals,
  NotEntitledLeaveApproverError, LeaveNotCancellableError, NotOwnLeaveRequestError,
} from "../../lib/leave.ts";
import { AttendanceLockedError } from "../../lib/attendance-locks.ts";

const router = Router();

function mapLeaveError(err: unknown, res: Response): boolean {
  if (err instanceof NotEntitledLeaveApproverError || err instanceof NotOwnLeaveRequestError) {
    res.status(403).json({ error: err.message });
    return true;
  }
  if (err instanceof AttendanceLockedError) {
    // Thrown from applyLeaveToAttendance() at final approval, or from
    // cancelLeaveRequest()'s pre-check — a date that got locked
    // between request creation and the decision being acted on.
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof LeaveNotCancellableError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

// ------------------------------------------------------------
// SELF-SERVICE: apply, cancel own, view own history
// ------------------------------------------------------------
router.post("/", requirePermission("leave.apply"), asyncHandler(async (req: Request, res: Response) => {
  const { leaveTypeId, fromDate, toDate, isHalfDay, halfDaySession, reason } = req.body ?? {};
  if (!leaveTypeId || !fromDate || !toDate || !reason) {
    return res.status(400).json({ error: "leaveTypeId, fromDate, toDate, and reason are required." });
  }
  try {
    const result = await createLeaveRequest(req.user!.userId, {
      employeeId: req.user!.userId, leaveTypeId, fromDate, toDate,
      isHalfDay: isHalfDay ?? false, halfDaySession: halfDaySession ?? null, reason,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (mapLeaveError(err, res)) return;
    return handleDomainError(err, res);
  }
}));

router.get("/my", requirePermission("leave.apply"), asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.query;
  const rows = await listLeaveRequests({ employeeId: req.user!.userId, status: status ? String(status) : undefined });
  return res.status(200).json(rows);
}));

router.get("/my/pending-approvals", requirePermission("leave.approve"), asyncHandler(async (req: Request, res: Response) => {
  const rows = await listMyPendingApprovals(req.user!.userId);
  return res.status(200).json(rows);
}));

router.post("/:id/cancel", requirePermission("leave.apply"), asyncHandler(async (req: Request, res: Response) => {
  const { cancellationReason } = req.body ?? {};
  if (!cancellationReason) return res.status(400).json({ error: "cancellationReason is required." });
  try {
    const result = await cancelLeaveRequest(req.user!.userId, Number(req.params.id), cancellationReason);
    return res.status(200).json(result);
  } catch (err) {
    if (mapLeaveError(err, res)) return;
    return handleDomainError(err, res);
  }
}));

// ------------------------------------------------------------
// HR-WIDE VIEW
// ------------------------------------------------------------
router.get("/", requirePermission("leave.view"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, status, departmentId, dateFrom, dateTo } = req.query;
  const rows = await listLeaveRequests({
    employeeId: employeeId ? Number(employeeId) : undefined,
    status: status ? String(status) : undefined,
    departmentId: departmentId ? Number(departmentId) : undefined,
    dateFrom: dateFrom ? String(dateFrom) : undefined,
    dateTo: dateTo ? String(dateTo) : undefined,
  });
  return res.status(200).json(rows);
}));

router.get("/:id", requirePermission("leave.view"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const request = await getLeaveRequest(Number(req.params.id));
    return res.status(200).json(request);
  } catch (err) {
    return handleDomainError(err, res);
  }
}));

// ------------------------------------------------------------
// APPROVAL — same coarse-permission + fine-grained-entitlement
// pattern as attendance corrections (leave.approve granted broadly to
// EMPLOYEE; isEntitledApprover, inside approveLeaveRequest/
// rejectLeaveRequest, does the real per-request restriction).
// ------------------------------------------------------------
router.post("/:id/approve", requirePermission("leave.approve"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await approveLeaveRequest(req.user!.userId, Number(req.params.id));
    return res.status(200).json(result);
  } catch (err) {
    if (mapLeaveError(err, res)) return;
    return handleDomainError(err, res);
  }
}));

router.post("/:id/reject", requirePermission("leave.approve"), asyncHandler(async (req: Request, res: Response) => {
  const { decisionNotes } = req.body ?? {};
  try {
    const result = await rejectLeaveRequest(req.user!.userId, Number(req.params.id), decisionNotes ?? null);
    return res.status(200).json(result);
  } catch (err) {
    if (mapLeaveError(err, res)) return;
    return handleDomainError(err, res);
  }
}));

export default router;
