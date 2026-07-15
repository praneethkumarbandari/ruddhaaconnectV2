import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import {
  dailyAttendanceReport, monthlyAttendanceRegister, lateEntryReport,
  earlyExitReport, overtimeReport, absentReport, attendanceSummary,
} from "../../lib/attendance-reports.ts";

const router = Router();

router.get("/daily", requirePermission("attendance.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { date, departmentId, branchId } = req.query;
  if (!date) return res.status(400).json({ error: "date is required." });
  const rows = await dailyAttendanceReport(String(date), {
    departmentId: departmentId ? Number(departmentId) : undefined,
    branchId: branchId ? Number(branchId) : undefined,
  });
  return res.status(200).json(rows);
}));

router.get("/monthly-register", requirePermission("attendance.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { year, month, departmentId } = req.query;
  if (!year || !month) return res.status(400).json({ error: "year and month are required." });
  const rows = await monthlyAttendanceRegister(Number(year), Number(month), { departmentId: departmentId ? Number(departmentId) : undefined });
  return res.status(200).json(rows);
}));

router.get("/late-entry", requirePermission("attendance.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom and dateTo are required." });
  const rows = await lateEntryReport(String(dateFrom), String(dateTo));
  return res.status(200).json(rows);
}));

router.get("/early-exit", requirePermission("attendance.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom and dateTo are required." });
  const rows = await earlyExitReport(String(dateFrom), String(dateTo));
  return res.status(200).json(rows);
}));

router.get("/overtime", requirePermission("attendance.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom and dateTo are required." });
  const rows = await overtimeReport(String(dateFrom), String(dateTo));
  return res.status(200).json(rows);
}));

router.get("/absent", requirePermission("attendance.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom and dateTo are required." });
  const rows = await absentReport(String(dateFrom), String(dateTo));
  return res.status(200).json(rows);
}));

router.get("/summary", requirePermission("attendance.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, dateFrom, dateTo } = req.query;
  if (!employeeId || !dateFrom || !dateTo) return res.status(400).json({ error: "employeeId, dateFrom, and dateTo are required." });
  const result = await attendanceSummary(Number(employeeId), String(dateFrom), String(dateTo));
  return res.status(200).json(result);
}));

export default router;
