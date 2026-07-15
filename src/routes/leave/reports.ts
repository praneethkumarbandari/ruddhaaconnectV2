import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import {
  leaveRegister, leaveBalanceReport, leaveUtilizationReport, leaveCalendar,
  employeeLeaveHistory, departmentLeaveSummary,
} from "../../lib/leave-reports.ts";

const router = Router();

router.get("/register", requirePermission("leave.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { dateFrom, dateTo, departmentId, status } = req.query;
  const rows = await leaveRegister({
    dateFrom: dateFrom ? String(dateFrom) : undefined,
    dateTo: dateTo ? String(dateTo) : undefined,
    departmentId: departmentId ? Number(departmentId) : undefined,
    status: status ? String(status) : undefined,
  });
  return res.status(200).json(rows);
}));

router.get("/balance-report", requirePermission("leave.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { leaveYear, departmentId } = req.query;
  if (!leaveYear) return res.status(400).json({ error: "leaveYear is required." });
  const rows = await leaveBalanceReport(Number(leaveYear), { departmentId: departmentId ? Number(departmentId) : undefined });
  return res.status(200).json(rows);
}));

router.get("/utilization", requirePermission("leave.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { leaveYear, departmentId } = req.query;
  if (!leaveYear) return res.status(400).json({ error: "leaveYear is required." });
  const rows = await leaveUtilizationReport(Number(leaveYear), { departmentId: departmentId ? Number(departmentId) : undefined });
  return res.status(200).json(rows);
}));

router.get("/calendar", requirePermission("leave.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { dateFrom, dateTo, departmentId } = req.query;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom and dateTo are required." });
  const rows = await leaveCalendar(String(dateFrom), String(dateTo), { departmentId: departmentId ? Number(departmentId) : undefined });
  return res.status(200).json(rows);
}));

router.get("/employee-history", requirePermission("leave.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.query.employeeId);
  if (!employeeId) return res.status(400).json({ error: "employeeId is required." });
  const result = await employeeLeaveHistory(employeeId);
  return res.status(200).json(result);
}));

router.get("/department-summary", requirePermission("leave.report.view"), asyncHandler(async (req: Request, res: Response) => {
  const { dateFrom, dateTo } = req.query;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom and dateTo are required." });
  const rows = await departmentLeaveSummary(String(dateFrom), String(dateTo));
  return res.status(200).json(rows);
}));

export default router;
