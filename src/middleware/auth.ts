import type { Request, Response, NextFunction } from "express";
import { verifyToken, type TokenPayload } from "../lib/jwt.ts";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * Requires a valid JWT on every request. This confirms WHO is making
 * the request — role/permission checks (WHAT they're allowed to do)
 * are a separate, layered concern, see middleware/permission.ts's
 * requirePermission().
 *
 * FIX (comment was stale, actively misleading): this used to say
 * "every route below currently allows any authenticated employee to
 * post" as a "Phase 4 concern, not yet built." Untrue by the time an
 * audit caught it — requirePermission() is wired into the large
 * majority of route files already (see that file's own comment,
 * also corrected). This file's job stays WHO, not WHAT — that hasn't
 * changed — but claiming WHAT was entirely unbuilt was wrong and
 * needed fixing, not just this file's job description.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }
  try {
    req.user = verifyToken(header.slice("Bearer ".length));
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}
