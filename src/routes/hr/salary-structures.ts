import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.salary_structure.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from salary_structures order by structure_code`);
  return res.status(200).json(rows);
}));

router.get("/:id", requirePermission("hr.salary_structure.view"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: structure } = await query(`select * from salary_structures where id = $1`, [id]);
  if (structure.length === 0) return res.status(404).json({ error: "Salary structure not found." });

  const { rows: components } = await query(
    `select ssc.*, sc.component_code, sc.component_name, sc.component_type
     from salary_structure_components ssc
     join salary_components sc on sc.id = ssc.component_id
     where ssc.structure_id = $1
     order by ssc.sequence, sc.component_code`,
    [id],
  );
  return res.status(200).json({ ...structure[0], components });
}));

router.post("/", requirePermission("hr.salary_structure.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { structureCode, structureName } = req.body ?? {};
  if (!structureCode || !structureName) {
    return res.status(400).json({ error: "structureCode and structureName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into salary_structures (structure_code, structure_name)
         values ($1, $2) returning *`,
        [structureCode, structureName],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "salary_structures",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Structure code "${structureCode}" already exists.` });
    }
    throw err;
  }
}));

router.post("/:id/deactivate", requirePermission("hr.salary_structure.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from salary_structures where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update salary_structures set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "salary_structures",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Salary structure not found." });
  return res.status(200).json(result);
}));

// ------------------------------------------------------------
// Structure <-> component lines. amount/percentage semantics are
// decided by the component's own calculation_type — enforced here
// (not just the DB's "at least one of the two" check) so the error
// message is specific rather than a generic constraint violation.
// ------------------------------------------------------------
router.post("/:id/components", requirePermission("hr.salary_structure.manage"), asyncHandler(async (req: Request, res: Response) => {
  const structureId = Number(req.params.id);
  const { componentId, amount, percentage, sequence } = req.body ?? {};
  if (!componentId) return res.status(400).json({ error: "componentId is required." });
  if (amount == null && percentage == null) {
    return res.status(400).json({ error: "Either amount or percentage is required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows: component } = await client.query(`select * from salary_components where id = $1`, [componentId]);
      if (component.length === 0) throw new ComponentNotFoundError(componentId);

      if (component[0].calculation_type === "fixed" && amount == null) {
        throw new CalculationTypeMismatchError(component[0].component_code, "fixed", "amount");
      }
      if (component[0].calculation_type === "percentage" && percentage == null) {
        throw new CalculationTypeMismatchError(component[0].component_code, "percentage", "percentage");
      }

      const { rows } = await client.query(
        `insert into salary_structure_components (structure_id, component_id, amount, percentage, sequence)
         values ($1, $2, $3, $4, $5)
         on conflict (structure_id, component_id)
         do update set amount = excluded.amount, percentage = excluded.percentage, sequence = excluded.sequence
         returning *`,
        [structureId, componentId, amount ?? null, percentage ?? null, sequence ?? 0],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "update",
        module: "salary_structure_components",
        recordId: structureId,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof ComponentNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof CalculationTypeMismatchError) return res.status(422).json({ error: err.message });
    if ((err as { code?: string }).code === "23503") {
      return res.status(400).json({ error: "structureId does not reference an existing salary structure." });
    }
    throw err;
  }
}));

router.delete("/:id/components/:componentId", requirePermission("hr.salary_structure.manage"), asyncHandler(async (req: Request, res: Response) => {
  const structureId = Number(req.params.id);
  const componentId = Number(req.params.componentId);

  await withTransaction(async (client) => {
    await client.query(
      `delete from salary_structure_components where structure_id = $1 and component_id = $2`,
      [structureId, componentId],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "salary_structure_components",
      recordId: structureId,
      oldValue: { structureId, componentId },
    });
  });

  return res.status(200).json({ removed: { structureId, componentId } });
}));

class ComponentNotFoundError extends Error {
  constructor(id: number) {
    super(`Salary component ${id} not found.`);
    this.name = "ComponentNotFoundError";
  }
}

class CalculationTypeMismatchError extends Error {
  constructor(componentCode: string, calculationType: string, expectedField: string) {
    super(`Component "${componentCode}" has calculation_type '${calculationType}' and requires '${expectedField}' to be set.`);
    this.name = "CalculationTypeMismatchError";
  }
}

export default router;
