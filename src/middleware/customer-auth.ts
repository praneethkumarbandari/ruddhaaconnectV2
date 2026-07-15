import type { Request, Response, NextFunction } from "express";
import { verifyCustomerToken, type CustomerTokenPayload } from "../lib/customer-auth.ts";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customer?: CustomerTokenPayload;
    }
  }
}

/**
 * Requires a valid customer-scoped JWT. Deliberately not the same
 * function as requireAuth (employee) — an employee's token has no
 * `scope: "customer"` field and will be rejected here, and a customer
 * token will equally be rejected by requireAuth, so the two sessions
 * can never be confused for one another even though they share a
 * signing secret.
 */
export function requireCustomerAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }
  try {
    req.customer = verifyCustomerToken(header.slice("Bearer ".length));
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
}
