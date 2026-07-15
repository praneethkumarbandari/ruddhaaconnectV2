import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps an async route handler so a thrown/rejected error is passed to
 * next(err) instead of becoming an unhandled promise rejection.
 *
 * Why this exists: Express 4 does not catch rejected promises from
 * async handlers automatically (that's an Express 5 behavior). Without
 * this wrapper, any handler that doesn't have its own try/catch will,
 * on a DB error or any other thrown exception, crash the entire
 * process — verified directly: a query against a dropped/renamed
 * table took the whole server down, not just that one request, with a
 * raw stack trace printed to the log and every other in-flight
 * request also dropped.
 *
 * Every route handler in this codebase must be wrapped with this,
 * including ones that already have an internal try/catch — consistency
 * here matters more than relying on each handler to remember.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
