import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.employment_type.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from employment_types order by employment_type_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.employment_type.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { employmentTypeCode, employmentTypeName } = req.body ?? {};
  if (!employmentTypeCode || !employmentTypeName) {
    return res.status(400).json({ error: "employmentTypeCode and employmentTypeName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into employment_types (employment_type_code, employment_type_name)
         values ($1, $2) returning *`,
        [employmentTypeCode, employmentTypeName],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "employment_types",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Employment type code "${employmentTypeCode}" already exists.` });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.employment_type.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { employmentTypeName } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from employment_types where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update employment_types set employment_type_name = coalesce($2, employment_type_name), updated_at = now()
       where id = $1 returning *`,
      [id, employmentTypeName ?? null],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "employment_types",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Employment type not found." });
  return res.status(200).json(result);
}));

router.post("/:id/deactivate", requirePermission("hr.employment_type.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from employment_types where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update employment_types set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "employment_types",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Employment type not found." });
  return res.status(200).json(result);
}));

export default router;
