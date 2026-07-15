import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/async-handler.ts";
import { listProjectCategories, createProjectCategory } from "../lib/projects.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("project-categories.view"));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const categories = await listProjectCategories();
  return res.status(200).json(categories);
}));

router.post("/", requirePermission("project-categories.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { name, description } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name is required." });
  const category = await createProjectCategory(name, description ?? null);
  return res.status(201).json(category);
}));

export default router;
