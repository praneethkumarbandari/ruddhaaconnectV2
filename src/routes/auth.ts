import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { pool, query } from "../db/pool.ts";
import { signToken } from "../lib/jwt.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requireAuth } from "../middleware/auth.ts";
import { tenantContextMiddleware } from "../middleware/tenant-context.ts";
import { authLoginLimiter } from "../middleware/rate-limit.ts";
import { resolveSchemaFromRequest } from "../lib/schema-resolver.ts";

const router = Router();

router.post("/login", authLoginLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required." });
  }

  // FIX (architecture pivot): this used to look up an employee by
  // username/email ACROSS every tenant's rows in one shared table,
  // then learn their tenant from the row it found. That's structurally
  // impossible now — each company's employees live in a genuinely
  // separate schema, so there's no "look up across everyone" query to
  // run at all. The subdomain the request arrived on IS how the
  // company is known, before any credential is even checked.
  //
  // schemaName is safe to interpolate directly here (not a bound
  // parameter, since Postgres can't parameterize a schema/table name)
  // because resolveSchemaFromRequest() already validated it against a
  // strict lowercase-letters/digits/underscore pattern and throws on
  // anything else — nothing reaches this string that isn't already a
  // real, safe identifier.
  const schemaName = resolveSchemaFromRequest(req);
  const { rows } = await pool.query(
    `select id, username, employee_name, password_hash, role from ${schemaName}.employees
     where (username = $1 or email = $1) and is_active = true`,
    [username],
  );

  if (rows.length === 0) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const employee = rows[0];
  const valid = await bcrypt.compare(password, employee.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const token = signToken({
    userId: Number(employee.id),
    username: employee.username,
    role: employee.role,
    schemaName,
  });
  return res.status(200).json({
    token,
    user: { id: employee.id, employee_id: employee.id, username: employee.username, employeeName: employee.employee_name, role: employee.role },
  });
}));

/**
 * FIX: content/settings.html already called POST /api/auth/change-password
 * — this route never existed on the backend at all, so every attempt to
 * change a password from Settings has always 404'd. Added here rather
 * than as a new top-level route because it's conceptually part of auth,
 * matching the frontend's existing call.
 *
 * IMPORTANT: /api/auth is mounted in app.ts BEFORE the blanket
 * `app.use("/api", requireAuth)` gate (same as /login, since a login
 * request has no token yet). change-password is different — it needs
 * to know WHO is changing their password — so it applies requireAuth
 * itself, explicitly, rather than relying on the router-level gate that
 * doesn't reach this path.
 *
 * FIX (multi-tenancy): for the exact same reason this route already
 * applies requireAuth itself instead of relying on the global gate,
 * it must also apply tenantContextMiddleware itself. /api/auth is
 * mounted before app.use("/api", tenantContextMiddleware) in app.ts,
 * so that global instance never runs for this path at all — there is
 * no risk of double-application here, only the risk of NOT applying
 * it at all if it were left off. Positioned after requireAuth, since
 * tenantContextMiddleware reads req.user.schemaName, which requireAuth
 * is what populates.
 */
router.post("/change-password", authLoginLimiter, requireAuth, tenantContextMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { current_password, new_password } = req.body ?? {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: "current_password and new_password are required." });
  }
  if (String(new_password).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }

  const { rows } = await query(
    `select id, password_hash from employees where id = $1 and is_active = true`,
    [req.user!.userId],
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: "Employee not found." });
  }

  const valid = await bcrypt.compare(current_password, rows[0].password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const newHash = await bcrypt.hash(new_password, 10);
  await query(`update employees set password_hash = $1 where id = $2`, [newHash, req.user!.userId]);

  return res.status(200).json({ message: "Password updated successfully." });
}));

export default router;
