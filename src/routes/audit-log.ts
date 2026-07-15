import { Router, type Request, type Response } from "express";
import { pool, query } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

/**
 * FIX: audit_log has been correctly written to by every module in
 * this system all along (every create/update/post/cancel/deactivate
 * writes here, inside the same transaction as the change itself) —
 * but there was no route anywhere to read it back. All of that
 * history existed and was permanently unviewable by anyone.
 *
 * Gated behind the same admin-level check as Roles & Permissions,
 * since audit history is sensitive (shows exactly who changed what,
 * including old/new values) and shouldn't be readable by every role.
 */
const router = Router();
router.use(requirePermission("audit-log.view"));

router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const { module, userId, fromDate, toDate, limit } = req.query as Record<string, string>;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (module) { params.push(module); conditions.push(`module = $${params.length}`); }
  if (userId) { params.push(Number(userId)); conditions.push(`user_id = $${params.length}`); }
  if (fromDate) { params.push(fromDate); conditions.push(`performed_at >= $${params.length}`); }
  if (toDate) { params.push(toDate); conditions.push(`performed_at <= $${params.length}::date + interval '1 day'`); }

  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const rowLimit = Math.min(Number(limit) || 200, 500);
  params.push(rowLimit);

  const { rows } = await query(
    `select al.*, e.employee_name, e.username
     from audit_log al
     left join employees e on e.id = al.user_id
     ${where}
     order by al.performed_at desc
     limit $${params.length}`,
    params,
  );
  return res.status(200).json(rows);
}));

router.get("/modules", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select distinct module from audit_log order by module`);
  return res.status(200).json(rows.map((r) => r.module));
}));

export default router;
