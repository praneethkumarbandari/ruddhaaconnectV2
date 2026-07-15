import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.department.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from departments order by department_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.department.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { departmentCode, departmentName, parentDepartmentId } = req.body ?? {};
  if (!departmentCode || !departmentName) {
    return res.status(400).json({ error: "departmentCode and departmentName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into departments (department_code, department_name, parent_department_id)
         values ($1, $2, $3) returning *`,
        [departmentCode, departmentName, parentDepartmentId ?? null],
      );
      const department = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "departments",
        recordId: department.id,
        newValue: department,
      });
      return department;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Department code "${departmentCode}" already exists.` });
    }
    if ((err as { code?: string }).code === "23503") {
      return res.status(400).json({ error: "parentDepartmentId does not reference an existing department." });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("hr.department.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { departmentName, parentDepartmentId } = req.body ?? {};

  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`select * from departments where id = $1`, [id]);
      if (existing.length === 0) return null;

      // FIX: department.id is a Postgres bigint, which the `pg` driver
      // returns as a string (to avoid JS number precision loss on large
      // bigints) — so a client round-tripping an id through JSON sends
      // it back as a string too. `id` here is Number()-coerced from the
      // URL param, so a strict `parentDepartmentId === id` compared a
      // string against a number and silently never matched, letting a
      // department be saved as its own parent. Coerce before comparing.
      if (parentDepartmentId != null && Number(parentDepartmentId) === id) {
        throw new SelfParentError();
      }

      const { rows } = await client.query(
        `update departments set
           department_name = coalesce($2, department_name),
           parent_department_id = $3,
           updated_at = now()
         where id = $1
         returning *`,
        [id, departmentName ?? null, parentDepartmentId ?? existing[0].parent_department_id],
      );
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "update",
        module: "departments",
        recordId: id,
        oldValue: existing[0],
        newValue: rows[0],
      });
      return rows[0];
    });

    if (!result) return res.status(404).json({ error: "Department not found." });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof SelfParentError) return res.status(422).json({ error: err.message });
    if ((err as { code?: string }).code === "23503") {
      return res.status(400).json({ error: "parentDepartmentId does not reference an existing department." });
    }
    throw err;
  }
}));

/**
 * Deactivate only — same rule as chart_of_accounts and every other
 * master in this system: history (designations, cost centers, and
 * eventually employees) may reference this row permanently.
 */
router.post("/:id/deactivate", requirePermission("hr.department.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from departments where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update departments set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "departments",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Department not found." });
  return res.status(200).json(result);
}));

class SelfParentError extends Error {
  constructor() {
    super("A department cannot be its own parent.");
    this.name = "SelfParentError";
  }
}

export default router;
