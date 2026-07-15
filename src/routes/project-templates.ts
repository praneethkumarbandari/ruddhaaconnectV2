import { Router, type Request, type Response } from "express";
import { withTransaction } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import {
  listTemplates, getTemplateWithLevelsAndStatuses, copyTemplate, setTemplateLevels, setTemplateStatuses,
} from "../lib/project-templates.ts";

const router = Router();
router.use(requirePermission("project_templates.view"));

router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const standardOnly = req.query.standardOnly === "true";
  return res.status(200).json(await listTemplates({ standardOnly }));
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  try {
    return res.status(200).json(await getTemplateWithLevelsAndStatuses(Number(req.params.id)));
  } catch (err) {
    handleDomainError(err, res);
  }
}));

/**
 * Standard Template -> Copy -> Customer Template. This is the ONLY
 * way a customer gets an editable template — never editing a standard
 * one in place (architecture decision #2).
 */
router.post("/:id/copy", requirePermission("project_templates.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { newTemplateName } = req.body ?? {};
  if (!newTemplateName) return res.status(400).json({ error: "newTemplateName is required." });
  try {
    const result = await withTransaction((client) =>
      copyTemplate(client, Number(req.params.id), newTemplateName, req.user?.userId ?? null),
    );
    return res.status(201).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.patch("/:id/levels", requirePermission("project_templates.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { levels } = req.body ?? {};
  if (!Array.isArray(levels)) return res.status(400).json({ error: "levels[] is required." });
  try {
    const result = await withTransaction((client) =>
      setTemplateLevels(
        client,
        Number(req.params.id),
        levels.map((l: any) => ({
          levelCode: l.levelCode, displayName: l.displayName,
          parentLevelCode: l.parentLevelCode ?? null, sortOrder: Number(l.sortOrder) || 0,
        })),
      ),
    );
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

router.patch("/:id/statuses", requirePermission("project_templates.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { statuses } = req.body ?? {};
  if (!Array.isArray(statuses)) return res.status(400).json({ error: "statuses[] is required." });
  try {
    const result = await withTransaction((client) =>
      setTemplateStatuses(
        client,
        Number(req.params.id),
        statuses.map((s: any) => ({
          statusCode: s.statusCode, displayName: s.displayName,
          isDefault: !!s.isDefault, sortOrder: Number(s.sortOrder) || 0,
        })),
      ),
    );
    return res.status(200).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

export default router;
