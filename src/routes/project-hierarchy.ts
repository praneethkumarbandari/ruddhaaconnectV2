import { Router, type Request, type Response } from "express";
import { withTransaction } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import { getProjectHierarchy, createNode, updateNode, deleteNode } from "../lib/project-hierarchy.ts";

const router = Router();
router.use(requirePermission("project_hierarchy.view"));

router.get("/:projectId", asyncHandler(async (req: Request, res: Response) => {
  return res.status(200).json(await getProjectHierarchy(Number(req.params.projectId)));
}));

router.post("/:projectId/nodes", requirePermission("project_hierarchy.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { parentNodeId, levelId, nodeCode, nodeName, description, sequence, status } = req.body ?? {};
  if (!levelId || !nodeName) return res.status(400).json({ error: "levelId and nodeName are required." });
  try {
    const result = await withTransaction((client) =>
      createNode(client, {
        projectId: Number(req.params.projectId),
        parentNodeId: parentNodeId != null ? Number(parentNodeId) : null,
        levelId: Number(levelId),
        nodeCode: nodeCode ?? null,
        nodeName,
        description: description ?? null,
        sequence: sequence != null ? Number(sequence) : 0,
        status: status ?? null,
        userId: req.user?.userId ?? null,
      }),
    );
    return res.status(201).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.patch("/nodes/:nodeId", requirePermission("project_hierarchy.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { nodeName, description, sequence, status } = req.body ?? {};
  try {
    const result = await withTransaction((client) =>
      updateNode(client, Number(req.params.nodeId), {
        nodeName, description, sequence: sequence != null ? Number(sequence) : undefined,
        status, userId: req.user?.userId ?? null,
      }),
    );
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.delete("/nodes/:nodeId", requirePermission("project_hierarchy.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await withTransaction((client) => deleteNode(client, Number(req.params.nodeId)));
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

export default router;
