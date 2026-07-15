import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import { listCostingRecords, createCostingRecord, updateCostingRecord, CostingRecordNotFoundError } from "../lib/costing.ts";

const router = Router();
router.use(requirePermission("costing.view"));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const rows = await listCostingRecords();
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("costing.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { sheetName, itemCode, projectId, materialCost, labourCost, overheadCost, notes } = req.body ?? {};
  if (!sheetName) return res.status(400).json({ error: "sheetName is required." });
  const record = await createCostingRecord({
    sheetName, itemCode: itemCode || null, projectId: projectId ? Number(projectId) : null,
    materialCost: Number(materialCost) || 0, labourCost: Number(labourCost) || 0, overheadCost: Number(overheadCost) || 0,
    notes, userId: req.user?.userId ?? null,
  });
  return res.status(201).json(record);
}));

router.patch("/:id", requirePermission("costing.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { sheetName, itemCode, projectId, materialCost, labourCost, overheadCost, notes } = req.body ?? {};
  if (!sheetName) return res.status(400).json({ error: "sheetName is required." });
  try {
    const record = await updateCostingRecord(Number(req.params.id), {
      sheetName, itemCode: itemCode || null, projectId: projectId ? Number(projectId) : null,
      materialCost: Number(materialCost) || 0, labourCost: Number(labourCost) || 0, overheadCost: Number(overheadCost) || 0,
      notes, userId: req.user?.userId ?? null,
    });
    return res.status(200).json(record);
  } catch (err) {
    if (err instanceof CostingRecordNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

export default router;
