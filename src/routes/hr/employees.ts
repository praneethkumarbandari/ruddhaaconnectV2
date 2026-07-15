import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { handleDomainError } from "../../lib/error-mapping.ts";
import {
  createEmployee, updateEmployee, getEmployee, listEmployees, getOrgTree, getManagerChain,
} from "../../lib/employees.ts";

const router = Router();

router.get("/", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  const { search, departmentId, designationId, branchId, status, page, pageSize } = req.query;
  const result = await listEmployees({
    search: search ? String(search) : undefined,
    departmentId: departmentId ? Number(departmentId) : undefined,
    designationId: designationId ? Number(designationId) : undefined,
    branchId: branchId ? Number(branchId) : undefined,
    status: status ? String(status) : undefined,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined,
  });
  return res.status(200).json(result);
}));

router.get("/:id", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const employee = await getEmployee(Number(req.params.id));
    return res.status(200).json(employee);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.get("/:id/org-tree", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const tree = await getOrgTree(Number(req.params.id));
    return res.status(200).json(tree);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.get("/:id/manager-chain", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  const chain = await getManagerChain(Number(req.params.id));
  return res.status(200).json(chain);
}));

router.post("/", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  const {
    employeeCode, employeeName, email, dateOfBirth, gender,
    departmentId, designationId, branchId, costCenterId, employmentTypeId, shiftId,
    reportingManagerId, joiningDate, confirmationDate, remarks,
  } = req.body ?? {};

  if (!employeeCode || !employeeName || !joiningDate) {
    return res.status(400).json({ error: "employeeCode, employeeName, and joiningDate are required." });
  }

  try {
    const result = await createEmployee(req.user?.userId ?? null, {
      employeeCode, employeeName, email, dateOfBirth, gender,
      departmentId, designationId, branchId, costCenterId, employmentTypeId, shiftId,
      reportingManagerId, joiningDate, confirmationDate, remarks,
    });
    return res.status(201).json(result);
  } catch (err) {
    const code = (err as { code?: string; constraint?: string }).code;
    if (code === "23505") {
      const constraint = (err as { constraint?: string }).constraint ?? "";
      if (constraint.includes("employee_code")) {
        return res.status(409).json({ error: `Employee code "${employeeCode}" already exists.` });
      }
      if (constraint.includes("username")) {
        return res.status(409).json({ error: `Generated username "${String(employeeCode).toLowerCase()}" already exists — employee codes must be unique.` });
      }
      if (constraint.includes("email")) {
        return res.status(409).json({ error: `Email "${email}" is already in use by another employee.` });
      }
      return res.status(409).json({ error: "A unique field on this employee already exists." });
    }
    return handleDomainError(err, res);
  }
}));

router.patch("/:id", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const result = await updateEmployee(req.user?.userId ?? null, id, req.body ?? {});
    return res.status(200).json(result);
  } catch (err) {
    return handleDomainError(err, res);
  }
}));

export default router;
