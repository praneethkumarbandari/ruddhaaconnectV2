import { Router, type Request, type Response } from "express";
import { pool, query } from "../../db/pool.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import {
  payrollRegister, salaryRegister, generatePayslip, loanRecoveryReport,
  departmentPayrollSummary, costCenterPayrollSummary, bankTransferReport,
} from "../../lib/payroll-reports.ts";

const router = Router();

router.get("/register/:runId", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const rows = await payrollRegister(Number(req.params.runId));
  return res.status(200).json(rows);
}));

router.get("/salary-register/:runId", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const rows = await salaryRegister(Number(req.params.runId));
  return res.status(200).json(rows);
}));

router.get("/payslip/:payrollLineId", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const result = await generatePayslip(Number(req.params.payrollLineId));
  if (!result) return res.status(404).json({ error: "Payroll line not found." });
  return res.status(200).json(result);
}));

/**
 * Self-service payslip — gated by payroll.reimbursement.claim
 * (granted broadly to EMPLOYEE, same "everyone gets basic
 * self-service" pattern used elsewhere), but that permission alone
 * says nothing about WHOSE payslip is being requested. The real
 * authorization is the ownership check below (payroll_lines.employee_id
 * must equal the caller) — the exact same class of gap Milestone 4's
 * leave cancellation had before being fixed, applied here from the
 * start rather than discovered by review a third time.
 */
router.get("/my/payslip/:payrollLineId", asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select employee_id from payroll_lines where id = $1`, [req.params.payrollLineId]);
  if (rows.length === 0) return res.status(404).json({ error: "Payslip not found." });
  if (Number(rows[0].employee_id) !== req.user!.userId) return res.status(403).json({ error: "You can only view your own payslips." });

  const result = await generatePayslip(Number(req.params.payrollLineId));
  return res.status(200).json(result);
}));

router.get("/loan-recovery", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: "period ('YYYY-MM') is required." });
  const rows = await loanRecoveryReport(String(period));
  return res.status(200).json(rows);
}));

router.get("/department-summary/:runId", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const rows = await departmentPayrollSummary(Number(req.params.runId));
  return res.status(200).json(rows);
}));

router.get("/cost-center-summary/:runId", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const rows = await costCenterPayrollSummary(Number(req.params.runId));
  return res.status(200).json(rows);
}));

router.get("/bank-transfer/:runId", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const rows = await bankTransferReport(Number(req.params.runId));
  return res.status(200).json(rows);
}));

export default router;
