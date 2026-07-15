import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.branch.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from branches order by branch_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.branch.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { branchCode, branchName, address, city, state } = req.body ?? {};
  if (!branchCode || !branchName) {
    return res.status(400).json({ error: "branchCode and branchName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into branches (branch_code, branch_name, address, city, state)
         values ($1, $2, $3, $4, $5) returning *`,
        [branchCode, branchName, address ?? null, city ?? null, state ?? null],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "branches",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Branch code "${branchCode}" already exists.` });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.branch.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { branchName, address, city, state } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from branches where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update branches set
         branch_name = coalesce($2, branch_name),
         address = coalesce($3, address),
         city = coalesce($4, city),
         state = coalesce($5, state),
         updated_at = now()
       where id = $1
       returning *`,
      [id, branchName ?? null, address ?? null, city ?? null, state ?? null],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "branches",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Branch not found." });
  return res.status(200).json(result);
}));

router.post("/:id/deactivate", requirePermission("hr.branch.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from branches where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update branches set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "branches",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Branch not found." });
  return res.status(200).json(result);
}));

export default router;
