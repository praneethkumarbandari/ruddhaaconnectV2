import { Router, type Request, type Response } from "express";
import { pool, query } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("employees.view"));

/**
 * Read-only, deliberately minimal — this is not employee management
 * (that belongs to a future HR module, per the architecture reference
 * handed to that separate effort). This exists only so screens that
 * need to pick an existing employee (e.g. Project Management's Team
 * tab) have a real list to choose from instead of a manual ID entry.
 * password_hash is never selected.
 */
router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(
    `select id, username, email, employee_name, is_active, created_at
     from employees
     where is_active = true
     order by employee_name asc`,
  );
  return res.status(200).json(rows);
}));

export default router;
