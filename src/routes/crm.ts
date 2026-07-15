import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import {
  listLeads, createLead, updateLead,
  listFollowups, createFollowup, updateFollowup,
  listActivities, createActivity, updateActivity,
  CrmLeadNotFoundError, CrmFollowupNotFoundError, CrmActivityNotFoundError,
} from "../lib/crm.ts";

const router = Router();
router.use(requirePermission("crm.view"));

// ------------------------------------------------------------
// LEADS
// ------------------------------------------------------------

router.get("/leads", asyncHandler(async (_req: Request, res: Response) => {
  const rows = await listLeads();
  return res.status(200).json(rows);
}));

router.post("/leads", requirePermission("crm.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { leadName, company, phone, email, customerId, status, estimatedValue, source, notes } = req.body ?? {};
  if (!leadName) return res.status(400).json({ error: "leadName is required." });
  const lead = await createLead({
    leadName, company, phone, email, customerId: customerId ? Number(customerId) : null,
    status: status || "new", estimatedValue: estimatedValue != null ? Number(estimatedValue) : null,
    source, notes, userId: req.user?.userId ?? null,
  });
  return res.status(201).json(lead);
}));

router.patch("/leads/:id", requirePermission("crm.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { leadName, company, phone, email, customerId, status, estimatedValue, source, notes } = req.body ?? {};
  if (!leadName) return res.status(400).json({ error: "leadName is required." });
  try {
    const lead = await updateLead(Number(req.params.id), {
      leadName, company, phone, email, customerId: customerId ? Number(customerId) : null,
      status: status || "new", estimatedValue: estimatedValue != null ? Number(estimatedValue) : null,
      source, notes, userId: req.user?.userId ?? null,
    });
    return res.status(200).json(lead);
  } catch (err) {
    if (err instanceof CrmLeadNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

// ------------------------------------------------------------
// FOLLOW-UPS
// ------------------------------------------------------------

router.get("/followups", asyncHandler(async (_req: Request, res: Response) => {
  const rows = await listFollowups();
  return res.status(200).json(rows);
}));

router.post("/followups", requirePermission("crm.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { leadId, dueDate, followupType, notes, status } = req.body ?? {};
  if (!leadId || !dueDate) return res.status(400).json({ error: "leadId and dueDate are required." });
  try {
    const followup = await createFollowup({
      leadId: Number(leadId), dueDate, followupType: followupType || "call", notes, status: status || "pending",
      userId: req.user?.userId ?? null,
    });
    return res.status(201).json(followup);
  } catch (err) {
    if (err instanceof CrmLeadNotFoundError) return res.status(400).json({ error: err.message });
    throw err;
  }
}));

router.patch("/followups/:id", requirePermission("crm.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { leadId, dueDate, followupType, notes, status } = req.body ?? {};
  if (!leadId || !dueDate) return res.status(400).json({ error: "leadId and dueDate are required." });
  try {
    const followup = await updateFollowup(Number(req.params.id), {
      leadId: Number(leadId), dueDate, followupType: followupType || "call", notes, status: status || "pending",
      userId: req.user?.userId ?? null,
    });
    return res.status(200).json(followup);
  } catch (err) {
    if (err instanceof CrmFollowupNotFoundError || err instanceof CrmLeadNotFoundError) return res.status(err instanceof CrmLeadNotFoundError ? 400 : 404).json({ error: err.message });
    throw err;
  }
}));

// ------------------------------------------------------------
// ACTIVITIES
// ------------------------------------------------------------

router.get("/activities", asyncHandler(async (_req: Request, res: Response) => {
  const rows = await listActivities();
  return res.status(200).json(rows);
}));

router.post("/activities", requirePermission("crm.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { leadId, activityDate, activityType, summary } = req.body ?? {};
  if (!leadId || !activityDate || !summary) return res.status(400).json({ error: "leadId, activityDate, and summary are required." });
  try {
    const activity = await createActivity({
      leadId: Number(leadId), activityDate, activityType: activityType || "call", summary,
      userId: req.user?.userId ?? null,
    });
    return res.status(201).json(activity);
  } catch (err) {
    if (err instanceof CrmLeadNotFoundError) return res.status(400).json({ error: err.message });
    throw err;
  }
}));

router.patch("/activities/:id", requirePermission("crm.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { leadId, activityDate, activityType, summary } = req.body ?? {};
  if (!leadId || !activityDate || !summary) return res.status(400).json({ error: "leadId, activityDate, and summary are required." });
  try {
    const activity = await updateActivity(Number(req.params.id), {
      leadId: Number(leadId), activityDate, activityType: activityType || "call", summary,
      userId: req.user?.userId ?? null,
    });
    return res.status(200).json(activity);
  } catch (err) {
    if (err instanceof CrmActivityNotFoundError || err instanceof CrmLeadNotFoundError) return res.status(err instanceof CrmLeadNotFoundError ? 400 : 404).json({ error: err.message });
    throw err;
  }
}));

export default router;
