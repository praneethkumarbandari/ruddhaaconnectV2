import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

const router = Router();

router.get("/", requirePermission("hr.holiday.view"), asyncHandler(async (req: Request, res: Response) => {
  const { year, branchId } = req.query;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (year) {
    params.push(Number(year));
    conditions.push(`extract(year from holiday_date) = $${params.length}`);
  }
  if (branchId) {
    params.push(Number(branchId));
    // branch_id IS NULL rows (all-branches holidays) always included
    // alongside the requested branch's own — a caller filtering by
    // branch still needs the company-wide holidays.
    conditions.push(`(branch_id = $${params.length} or branch_id is null)`);
  }

  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(`select * from holidays ${where} order by holiday_date`, params);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.holiday.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { holidayDate, holidayName, branchId } = req.body ?? {};
  if (!holidayDate || !holidayName) {
    return res.status(400).json({ error: "holidayDate and holidayName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      // Application-level duplicate check for the branchId === null
      // (all-branches) case only — the branch_id IS NOT NULL case is
      // caught by the partial unique index and its 23505 below. See
      // the note in schema-hr-masters.sql for why both are needed.
      if (!branchId) {
        const { rows: dupes } = await client.query(
          `select id from holidays where holiday_date = $1 and branch_id is null`,
          [holidayDate],
        );
        if (dupes.length > 0) {
          throw new DuplicateHolidayError(holidayDate);
        }
      }

      const { rows } = await client.query(
        `insert into holidays (holiday_date, holiday_name, branch_id)
         values ($1, $2, $3) returning *`,
        [holidayDate, holidayName, branchId ?? null],
      );
      const record = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "holidays",
        recordId: record.id,
        newValue: record,
      });
      return record;
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof DuplicateHolidayError) {
      return res.status(409).json({ error: err.message });
    }
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `A holiday for this branch already exists on ${holidayDate}.` });
    }
    if ((err as { code?: string }).code === "23503") {
      return res.status(400).json({ error: "branchId does not reference an existing branch." });
    }
    throw err;
  }
}));

router.post("/:id/deactivate", requirePermission("hr.holiday.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from holidays where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update holidays set is_active = false, updated_at = now() where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "deactivate",
      module: "holidays",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Holiday not found." });
  return res.status(200).json(result);
}));

class DuplicateHolidayError extends Error {
  constructor(holidayDate: string) {
    super(`An all-branches holiday already exists on ${holidayDate}.`);
    this.name = "DuplicateHolidayError";
  }
}

export default router;
