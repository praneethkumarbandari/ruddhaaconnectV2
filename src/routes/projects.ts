import { Router, type Request, type Response } from "express";
import { withTransaction } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import { requirePermission } from "../middleware/permission.ts";
import { createProject, getProject, listProjects, changeProjectStatus } from "../lib/projects.ts";
import { addMember, removeMember, listMembers } from "../lib/project-members.ts";
import { listProjectActivity } from "../lib/project-activity-log.ts";
import {
  createBudgetVersion, addBudgetLine, approveBudgetVersion, supersedeBudgetVersion,
  listBudgetVersions, getBudgetVersionWithLines,
} from "../lib/project-budget.ts";
import { createMilestone, updateMilestoneStatus, listMilestones, createTask, updateTaskStatus, listTasks } from "../lib/project-tasks.ts";
import { addDocument, removeDocument, listDocuments, addNote, listNotes } from "../lib/project-documents.ts";
import {
  budgetVsActual, projectRevenue, projectCost, projectCashFlow, projectOutstanding,
  projectProfitability, projectDashboard, projectFinancialTimeline,
} from "../lib/project-reports.ts";

const router = Router();
router.use(requirePermission("projects.view"));

router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const { status, categoryId, customerId } = req.query;
  const projects = await listProjects({
    status: typeof status === "string" ? status : undefined,
    categoryId: categoryId ? Number(categoryId) : undefined,
    customerId: customerId ? Number(customerId) : undefined,
  });
  return res.status(200).json(projects);
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  try {
    const project = await getProject(Number(req.params.id));
    return res.status(200).json(project);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { projectCode, projectName, categoryId, customerId, templateId, startDate, targetEndDate } = req.body ?? {};
  if (!projectCode || !projectName) {
    return res.status(400).json({ error: "projectCode and projectName are required." });
  }
  try {
    const project = await withTransaction((client) =>
      createProject(client, {
        projectCode,
        projectName,
        categoryId: categoryId ? Number(categoryId) : null,
        customerId: customerId ? Number(customerId) : null,
        templateId: templateId ? Number(templateId) : null,
        startDate: startDate ?? null,
        targetEndDate: targetEndDate ?? null,
        createdBy: req.user?.userId ?? null,
      }),
    );
    return res.status(201).json(project);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/:id/status", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  if (!status) return res.status(400).json({ error: "status is required." });
  try {
    const project = await withTransaction((client) =>
      changeProjectStatus(client, Number(req.params.id), status, req.user?.userId ?? null),
    );
    return res.status(200).json(project);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.get("/:id/members", asyncHandler(async (req: Request, res: Response) => {
  const members = await listMembers(Number(req.params.id));
  return res.status(200).json(members);
}));

router.get("/:id/activity", asyncHandler(async (req: Request, res: Response) => {
  const activity = await listProjectActivity(Number(req.params.id));
  return res.status(200).json(activity);
}));

router.post("/:id/members", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, role } = req.body ?? {};
  if (!employeeId) return res.status(400).json({ error: "employeeId is required." });
  try {
    const member = await withTransaction((client) =>
      addMember(client, Number(req.params.id), Number(employeeId), role ?? "member", req.user?.userId ?? null),
    );
    return res.status(201).json(member);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.delete("/:id/members/:employeeId", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    await withTransaction((client) =>
      removeMember(client, Number(req.params.id), Number(req.params.employeeId), req.user?.userId ?? null),
    );
    return res.status(204).send();
  } catch (err) {
    handleDomainError(err, res);
  }
}));


// ------------------------------------------------------------------
// Budget Versions / Budget Lines
// ------------------------------------------------------------------

router.post("/:id/budget-versions", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const version = await withTransaction((client) =>
      createBudgetVersion(client, Number(req.params.id), req.user?.userId ?? null),
    );
    return res.status(201).json(version);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.get("/:id/budget-versions", asyncHandler(async (req: Request, res: Response) => {
  const versions = await listBudgetVersions(Number(req.params.id));
  return res.status(200).json(versions);
}));

router.get("/budget-versions/:versionId", asyncHandler(async (req: Request, res: Response) => {
  try {
    const version = await getBudgetVersionWithLines(Number(req.params.versionId));
    return res.status(200).json(version);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/budget-versions/:versionId/lines", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { accountCode, categoryLabel, budgetType, budgetedAmount } = req.body ?? {};
  if (!budgetType || budgetedAmount == null) {
    return res.status(400).json({ error: "budgetType and budgetedAmount are required." });
  }
  try {
    const line = await withTransaction((client) =>
      addBudgetLine(client, Number(req.params.versionId), {
        accountCode: accountCode ?? null,
        categoryLabel: categoryLabel ?? null,
        budgetType,
        budgetedAmount: Number(budgetedAmount),
      }),
    );
    return res.status(201).json(line);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/budget-versions/:versionId/approve", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const version = await withTransaction((client) =>
      approveBudgetVersion(client, Number(req.params.versionId), req.user?.userId ?? null),
    );
    return res.status(200).json(version);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/budget-versions/:versionId/supersede", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const version = await withTransaction((client) =>
      supersedeBudgetVersion(client, Number(req.params.versionId), req.user?.userId ?? null),
    );
    return res.status(200).json(version);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

// ------------------------------------------------------------------
// Milestones / Tasks
// ------------------------------------------------------------------

router.post("/:id/milestones", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { milestoneName, targetDate } = req.body ?? {};
  if (!milestoneName) return res.status(400).json({ error: "milestoneName is required." });
  try {
    const milestone = await withTransaction((client) =>
      createMilestone(client, Number(req.params.id), milestoneName, targetDate ?? null, req.user?.userId ?? null),
    );
    return res.status(201).json(milestone);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.get("/:id/milestones", asyncHandler(async (req: Request, res: Response) => {
  const milestones = await listMilestones(Number(req.params.id));
  return res.status(200).json(milestones);
}));

router.post("/milestones/:milestoneId/status", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  if (!status) return res.status(400).json({ error: "status is required." });
  try {
    const milestone = await withTransaction((client) =>
      updateMilestoneStatus(client, Number(req.params.milestoneId), status, req.user?.userId ?? null),
    );
    return res.status(200).json(milestone);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/:id/tasks", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { taskName, milestoneId, assigneeId, dueDate } = req.body ?? {};
  if (!taskName) return res.status(400).json({ error: "taskName is required." });
  try {
    const task = await withTransaction((client) =>
      createTask(client, Number(req.params.id), {
        taskName,
        milestoneId: milestoneId ? Number(milestoneId) : null,
        assigneeId: assigneeId ? Number(assigneeId) : null,
        dueDate: dueDate ?? null,
      }, req.user?.userId ?? null),
    );
    return res.status(201).json(task);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.get("/:id/tasks", asyncHandler(async (req: Request, res: Response) => {
  const { milestoneId } = req.query;
  const tasks = await listTasks(Number(req.params.id), milestoneId ? Number(milestoneId) : undefined);
  return res.status(200).json(tasks);
}));

router.post("/tasks/:taskId/status", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  if (!status) return res.status(400).json({ error: "status is required." });
  try {
    const task = await withTransaction((client) =>
      updateTaskStatus(client, Number(req.params.taskId), status, req.user?.userId ?? null),
    );
    return res.status(200).json(task);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

// ------------------------------------------------------------------
// Documents / Notes
// ------------------------------------------------------------------

router.post("/:id/documents", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { fileName, storagePath } = req.body ?? {};
  if (!fileName || !storagePath) return res.status(400).json({ error: "fileName and storagePath are required." });
  try {
    const doc = await withTransaction((client) =>
      addDocument(client, Number(req.params.id), fileName, storagePath, req.user?.userId ?? null),
    );
    return res.status(201).json(doc);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.get("/:id/documents", asyncHandler(async (req: Request, res: Response) => {
  const documents = await listDocuments(Number(req.params.id));
  return res.status(200).json(documents);
}));

router.delete("/documents/:documentId", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    await withTransaction((client) => removeDocument(client, Number(req.params.documentId), req.user?.userId ?? null));
    return res.status(204).send();
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.post("/:id/notes", requirePermission("projects.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { note } = req.body ?? {};
  if (!note) return res.status(400).json({ error: "note is required." });
  try {
    const created = await withTransaction((client) =>
      addNote(client, Number(req.params.id), req.user?.userId ?? null, note),
    );
    return res.status(201).json(created);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.get("/:id/notes", asyncHandler(async (req: Request, res: Response) => {
  const notes = await listNotes(Number(req.params.id));
  return res.status(200).json(notes);
}));

// ------------------------------------------------------------------
// Reporting (all read-only — see project-reports.ts)
// ------------------------------------------------------------------

router.get("/:id/reports/dashboard", asyncHandler(async (req: Request, res: Response) => {
  const dashboard = await projectDashboard(Number(req.params.id));
  return res.status(200).json(dashboard);
}));

router.get("/:id/reports/budget-vs-actual", asyncHandler(async (req: Request, res: Response) => {
  const result = await budgetVsActual(Number(req.params.id));
  return res.status(200).json(result);
}));

router.get("/:id/reports/revenue", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query;
  const result = await projectRevenue(Number(req.params.id), fromDate as string | undefined, toDate as string | undefined);
  return res.status(200).json(result);
}));

router.get("/:id/reports/cost", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query;
  const result = await projectCost(Number(req.params.id), fromDate as string | undefined, toDate as string | undefined);
  return res.status(200).json(result);
}));

router.get("/:id/reports/profitability", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query;
  const result = await projectProfitability(Number(req.params.id), fromDate as string | undefined, toDate as string | undefined);
  return res.status(200).json(result);
}));

router.get("/:id/reports/cashflow", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query;
  const result = await projectCashFlow(Number(req.params.id), fromDate as string | undefined, toDate as string | undefined);
  return res.status(200).json(result);
}));

router.get("/:id/reports/outstanding", asyncHandler(async (req: Request, res: Response) => {
  const result = await projectOutstanding(Number(req.params.id));
  return res.status(200).json(result);
}));

router.get("/:id/reports/timeline", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query;
  if (!fromDate || !toDate) {
    return res.status(400).json({ error: "fromDate and toDate are required for the financial timeline." });
  }
  const result = await projectFinancialTimeline(Number(req.params.id), fromDate as string, toDate as string);
  return res.status(200).json(result);
}));
export default router;
