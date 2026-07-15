import { Router, type Request, type Response } from "express";
import { withTransaction } from "../../db/pool.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { upsertAttendanceRecord, getAttendanceRecord, listAttendanceRecords, AttendanceRecordNotFoundError, AttendanceOutsideEmploymentError } from "../../lib/attendance.ts";
import { AttendanceLockedError } from "../../lib/attendance-locks.ts";

const router = Router();

router.get("/", requirePermission("attendance.record.view"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, departmentId, dateFrom, dateTo, status, page, pageSize } = req.query;
  const result = await listAttendanceRecords({
    employeeId: employeeId ? Number(employeeId) : undefined,
    departmentId: departmentId ? Number(departmentId) : undefined,
    dateFrom: dateFrom ? String(dateFrom) : undefined,
    dateTo: dateTo ? String(dateTo) : undefined,
    statusCode: status ? String(status) : undefined,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined,
  });
  return res.status(200).json(result);
}));

// ------------------------------------------------------------
// SELF-SERVICE — no attendance.* permission required beyond being
// authenticated; scoped strictly to the caller's own employee_id.
// Registered BEFORE "/:id" deliberately: Express matches routes in
// registration order, not by specificity, so "/my" must come first
// or a request to GET /my would instead match "/:id" with id="my".
// ------------------------------------------------------------
router.get("/my", asyncHandler(async (req: Request, res: Response) => {
  const { dateFrom, dateTo, page, pageSize } = req.query;
  const result = await listAttendanceRecords({
    employeeId: req.user!.userId,
    dateFrom: dateFrom ? String(dateFrom) : undefined,
    dateTo: dateTo ? String(dateTo) : undefined,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined,
  });
  return res.status(200).json(result);
}));

/**
 * Manual entry — "HR-only, exceptional use" per the permission's own
 * description. This is NOT the correction workflow (no approval, no
 * per-employee self-service) — it exists for cases like backfilling a
 * new joiner's first week before any import has run. Still goes
 * through the exact same upsertAttendanceRecord() as every other
 * write path, so the lock check and calculation logic are identical.
 * Also registered before "/:id" for the same route-ordering reason.
 */
router.put("/manual", requirePermission("attendance.record.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, attendanceDate, inTimestamp, outTimestamp, remarks } = req.body ?? {};
  if (!employeeId || !attendanceDate) return res.status(400).json({ error: "employeeId and attendanceDate are required." });

  try {
    const result = await withTransaction((client) =>
      upsertAttendanceRecord(client, req.user?.userId ?? null, {
        employeeId, attendanceDate, inTimestamp: inTimestamp ?? null, outTimestamp: outTimestamp ?? null, source: "manual", remarks,
      }),
    );
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof AttendanceLockedError) return res.status(409).json({ error: err.message });
    if (err instanceof AttendanceOutsideEmploymentError) return res.status(422).json({ error: err.message });
    throw err;
  }
}));

router.get("/:id", requirePermission("attendance.record.view"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const record = await getAttendanceRecord(Number(req.params.id));
    return res.status(200).json(record);
  } catch (err) {
    if (err instanceof AttendanceRecordNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

export default router;
