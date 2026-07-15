import type { Request, Response, NextFunction } from "express";
import { employeeHasPermission } from "../lib/rbac-permissions.ts";

/**
 * WHAT the caller can do, layered on top of requireAuth's WHO. Must
 * run after requireAuth (needs req.user.userId) — same ordering
 * app.ts already uses for the global `/api` -> requireAuth mount.
 *
 * Deliberately its own file rather than added to middleware/auth.ts:
 * requireAuth's identity check is unconditional infrastructure every
 * route depends on, while this is opt-in per route/module, and the
 * two are allowed to evolve independently (e.g. permission caching)
 * without touching the auth gate every other module already relies on.
 *
 * FIX (comment was stale, actively misleading): this used to say
 * "only wired into HR routes for now." That was true once, isn't
 * anymore — an audit correctly caught this. requirePermission() is
 * now used across the large majority of route files spanning
 * Accounting, CRM, HR, Inventory, Project Management, Reports, and
 * Admin, not just HR. Whether a *specific* route/module has it wired
 * in is that module's own decision, same as always — this comment
 * just shouldn't have implied the rollout was still narrow when it
 * genuinely isn't anymore.
 */
export function requirePermission(permissionCode: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      // Should be unreachable in practice (requireAuth runs first on
      // every /api/* route) — guarded explicitly rather than assumed,
      // since a silent `undefined.userId` here would be a 500, not
      // the 401 the caller actually needs.
      return res.status(401).json({ error: "Missing or malformed Authorization header." });
    }
    try {
      const allowed = await employeeHasPermission(req.user.userId, permissionCode);
      if (!allowed) {
        return res.status(403).json({ error: `Missing required permission: ${permissionCode}` });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
