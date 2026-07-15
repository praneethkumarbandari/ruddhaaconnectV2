import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.designation.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from designations order by designation_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.designation.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { designationCode, designationName, departmentId } = req.body ?? {};
  if (!designationCode || !designationName) {
    return res.status(400).json({ error: "designationCode and designationName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into designations (designation_code, designation_name, department_id)
         values ($1, $2, $3) returning *`,
        [designationCode, designationName, departmentId ?? null],
      );
      const designation = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "designations",
        recordId: designation.id,
        newValue: designation,
      });
      return designation;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Designation code "${designationCode}" already exists.` });
    }
    if ((err as { code?: string }).code === "23503") {
      return res.status(400).json({ error: "departmentId does not reference an existing department." });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.designation.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { designationName, departmentId } = req.body ?? {};

  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`select * from designations where id = $1`, [id]);
      if (existing.length === 0) return null;

      const { rows } = await client.query(
        `update designations set
           designation_name = coalesce($2, designation_name),
           department_id = $3,
           updated_at = now()
         where id = $1
         returning *`,
        [id, designationName ?? null, departmentId ?? existing[0].department_id],
      );
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "update",
        module: "designations",
        recordId: id,
        oldValue: existing[0],
        newValue: rows[0],
      });
      return rows[0];
    });

    if (!result) return res.status(404).json({ error: "Designation not found." });
    return res.status(200).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23503") {
      return res.status(400).json({ error: "departmentId does not reference an existing department." });
    }
    throw err;
  }
}));

router.post("/:id/deactivate", requirePermission("hr.designation.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from designations where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update designations set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "designations",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Designation not found." });
  return res.status(200).json(result);
}));

export default router;
