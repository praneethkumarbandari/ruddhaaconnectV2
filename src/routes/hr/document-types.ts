import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.document_type.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from document_types order by document_type_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.document_type.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { documentTypeCode, documentTypeName, isMandatory } = req.body ?? {};
  if (!documentTypeCode || !documentTypeName) {
    return res.status(400).json({ error: "documentTypeCode and documentTypeName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into document_types (document_type_code, document_type_name, is_mandatory)
         values ($1, $2, $3) returning *`,
        [documentTypeCode, documentTypeName, isMandatory ?? false],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "document_types",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Document type code "${documentTypeCode}" already exists.` });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.document_type.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { documentTypeName, isMandatory } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from document_types where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update document_types set
         document_type_name = coalesce($2, document_type_name),
         is_mandatory = coalesce($3, is_mandatory),
         updated_at = now()
       where id = $1
       returning *`,
      [id, documentTypeName ?? null, isMandatory ?? null],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "document_types",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Document type not found." });
  return res.status(200).json(result);
}));

router.post("/:id/deactivate", requirePermission("hr.document_type.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from document_types where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update document_types set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "document_types",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Document type not found." });
  return res.status(200).json(result);
}));

export default router;
