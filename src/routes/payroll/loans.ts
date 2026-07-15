import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { createLoan, getLoan, listLoans, settleLoan, LoanNotFoundError, LoanNotActiveError } from "../../lib/payroll-loans.ts";

const router = Router();

router.get("/", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, status } = req.query;
  const rows = await listLoans({ employeeId: employeeId ? Number(employeeId) : undefined, status: status ? String(status) : undefined });
  return res.status(200).json(rows);
}));

router.get("/:id", requirePermission("payroll.view"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const loan = await getLoan(Number(req.params.id));
    return res.status(200).json(loan);
  } catch (err) {
    if (err instanceof LoanNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

router.post("/", requirePermission("payroll.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, loanType, principalAmount, interestRate, emiAmount, numberOfInstallments, disbursedDate } = req.body ?? {};
  if (!employeeId || !loanType || !principalAmount || !emiAmount || !numberOfInstallments || !disbursedDate) {
    return res.status(400).json({ error: "employeeId, loanType, principalAmount, emiAmount, numberOfInstallments, and disbursedDate are required." });
  }
  try {
    const result = await createLoan(req.user?.userId ?? null, { employeeId, loanType, principalAmount, interestRate, emiAmount, numberOfInstallments, disbursedDate });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes("employee_master")) return res.status(400).json({ error: err.message });
    if ((err as { code?: string }).code === "23514") return res.status(422).json({ error: "principalAmount, emiAmount, and numberOfInstallments must be positive." });
    throw err;
  }
}));

router.post("/:id/settle", requirePermission("payroll.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { settlementNotes } = req.body ?? {};
  if (!settlementNotes) return res.status(400).json({ error: "settlementNotes is required." });
  try {
    const result = await settleLoan(req.user!.userId, Number(req.params.id), settlementNotes);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof LoanNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof LoanNotActiveError) return res.status(422).json({ error: err.message });
    throw err;
  }
}));

export default router;
