import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import {
  createCorrectionRequest, approveCorrectionRequest, rejectCorrectionRequest,
  getCorrectionRequest, listCorrectionRequests,
  CorrectionRequestNotFoundError, CorrectionNotPendingError, NotEntitledApproverError,
} from "../../lib/attendance-corrections.ts";
import { NoReportingManagerError, HierarchyNotFoundError } from "../../lib/approvals.ts";
import { AttendanceLockedError } from "../../lib/attendance-locks.ts";
import { AttendanceOutsideEmploymentError } from "../../lib/attendance.ts";

const router = Router();

function mapCorrectionError(err: unknown, res: Response): boolean {
  if (err instanceof CorrectionRequestNotFoundError || err instanceof HierarchyNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  if (err instanceof CorrectionNotPendingError || err instanceof NoReportingManagerError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  if (err instanceof NotEntitledApproverError) {
    res.status(403).json({ error: err.message });
    return true;
  }
  if (err instanceof AttendanceLockedError) {
    // Thrown from applyCorrection()'s call to upsertAttendanceRecord()
    // at the final approval level, if the date was locked sometime
    // between the request being raised and its final approval —
    // a real timing case a correction workflow with a real approval
    // delay can hit, not a hypothetical.
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof AttendanceOutsideEmploymentError) {
    // e.g. the correction sat pending long enough that the employee
    // has since exited and their exit_date now precedes the
    // requested attendance_date — a real "correction after
    // termination"-adjacent timing case, not a hypothetical.
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

/**
 * Self-service: "Employee -> Attendance Correction Request" — gated
 * by attendance.correction.request, which the EMPLOYEE baseline role
 * holds by default (schema-attendance.sql seed), so every employee
 * can request a correction for their OWN attendance without needing
 * any HR-wide permission. The request is always attributed to the
 * caller's own employee_id — there is no field for requesting on
 * someone else's behalf here (HR entering a correction directly is
 * routes/attendance/records.ts's manual-entry path instead, which is
 * a distinct, HR-only, non-approval action).
 */
router.post("/", requirePermission("attendance.correction.request"), asyncHandler(async (req: Request, res: Response) => {
  const { attendanceDate, requestedInTimestamp, requestedOutTimestamp, reason } = req.body ?? {};
  if (!attendanceDate || !reason) return res.status(400).json({ error: "attendanceDate and reason are required." });
  if (!requestedInTimestamp && !requestedOutTimestamp) {
    return res.status(400).json({ error: "At least one of requestedInTimestamp or requestedOutTimestamp is required." });
  }

  const result = await createCorrectionRequest(req.user!.userId, {
    employeeId: req.user!.userId,
    attendanceDate,
    requestedInTimestamp: requestedInTimestamp ?? null,
    requestedOutTimestamp: requestedOutTimestamp ?? null,
    reason,
  });
  return res.status(201).json(result);
}));

router.get("/my", requirePermission("attendance.correction.request"), asyncHandler(async (req: Request, res: Response) => {
  const rows = await listCorrectionRequests({ employeeId: req.user!.userId });
  return res.status(200).json(rows);
}));

router.get("/", requirePermission("attendance.correction.approve"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, status } = req.query;
  const rows = await listCorrectionRequests({
    employeeId: employeeId ? Number(employeeId) : undefined,
    status: status ? String(status) : undefined,
  });
  return res.status(200).json(rows);
}));

router.get("/:id", requirePermission("attendance.correction.approve"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const request = await getCorrectionRequest(Number(req.params.id));
    return res.status(200).json(request);
  } catch (err) {
    if (mapCorrectionError(err, res)) return;
    throw err;
  }
}));

/**
 * Approve at the current level. Being entitled to call this requires
 * BOTH the base attendance.correction.approve permission AND being
 * the specific resolved approver for this request's current level
 * (checked inside approveCorrectionRequest via isEntitledApprover) —
 * the permission is a coarse gate, the entitlement check is the real,
 * per-request authorization.
 */
router.post("/:id/approve", requirePermission("attendance.correction.approve"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await approveCorrectionRequest(req.user!.userId, Number(req.params.id));
    return res.status(200).json(result);
  } catch (err) {
    if (mapCorrectionError(err, res)) return;
    throw err;
  }
}));

router.post("/:id/reject", requirePermission("attendance.correction.approve"), asyncHandler(async (req: Request, res: Response) => {
  const { decisionNotes } = req.body ?? {};
  try {
    const result = await rejectCorrectionRequest(req.user!.userId, Number(req.params.id), decisionNotes ?? null);
    return res.status(200).json(result);
  } catch (err) {
    if (mapCorrectionError(err, res)) return;
    throw err;
  }
}));

export default router;
