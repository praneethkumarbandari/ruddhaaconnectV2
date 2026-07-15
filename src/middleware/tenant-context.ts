import type { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool.ts";
import { tenantContextStorage, type TenantContext } from "../db/tenant-context.ts";

/**
 * FIX (architecture pivot): this used to set_config('app.tenant_id',
 * ...) against Row-Level Security policies on shared tables. The
 * business owner's actual, consistently-stated requirement was
 * separate tables per company, not a shared table with a hidden
 * column deciding visibility — see schema-per-tenant-architecture.sql
 * for the real isolation mechanism now: each company gets its own
 * Postgres schema, containing its own physically separate copies of
 * every table.
 *
 * What carries over completely unchanged from the RLS-era version:
 * one connection checked out per HTTP request, wrapped in a
 * transaction for the whole request, made available to every query
 * via the same AsyncLocalStorage (../db/tenant-context.ts). Every
 * existing bare table reference across the whole codebase (select *
 * from customers, never select * from public.customers — verified,
 * nothing hardcodes a schema prefix) transparently resolves against
 * whichever schema is set here, with zero changes needed to any of
 * the ~35 files already migrated to query()/withTransaction().
 *
 * set_config('search_path', ..., true) — not a raw SET search_path
 * string — for the same reason the old version used set_config for
 * app.tenant_id: schemaName is passed as a real bound parameter, not
 * string-interpolated into SQL. is_local=true scopes it to this one
 * transaction, automatically cleared on COMMIT or ROLLBACK, so a
 * pooled connection can never leak one request's schema into another
 * request that happens to reuse it afterward.
 */
export async function tenantContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const schemaName = req.user?.schemaName;
  if (!schemaName) {
    // No authenticated company on this request — public routes
    // (/api/auth/login, /api/setup/bootstrap-admin, the customer
    // portal's own separate auth) don't touch any company's tables at
    // all before an identity exists to select a schema by. Proceed
    // with no context; any code that later expects one and doesn't
    // find it is a bug to surface loudly, not paper over here.
    return next();
  }

  const client = await pool.connect();
  let settled = false;

  const finish = async (commit: boolean) => {
    if (settled) return;
    settled = true;
    try {
      await client.query(commit ? "COMMIT" : "ROLLBACK");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("tenantContextMiddleware: failed to finalize transaction", err);
    } finally {
      client.release();
    }
  };

  try {
    await client.query("BEGIN");
    await client.query(`select set_config('search_path', $1, true)`, [`${schemaName}, public`]);
  } catch (err) {
    // Never got past BEGIN/set_config — nothing to roll back, just
    // release and hand off to the real error handler.
    client.release();
    return next(err);
  }

  // Fires once the response is fully sent, success or not — by the
  // time this runs after an error, tenantContextErrorHandler has
  // already called finish(false) and set settled=true, so this is a
  // harmless no-op in that case, not a second, conflicting attempt.
  res.on("finish", () => {
    void finish(res.statusCode < 400);
  });

  const context: TenantContext = { client, schemaName, finish };
  tenantContextStorage.run(context, () => next());
}

/**
 * Mounted as Express error-handling middleware (4 params — that's
 * what makes Express treat it as an error handler), positioned BEFORE
 * the existing final error handler in app.ts so this always runs
 * first on any thrown/rejected error, rolls back the request's
 * transaction, then hands off via next(err) so the existing handler's
 * actual HTTP response behavior is completely unchanged.
 */
export function tenantContextErrorHandler(err: unknown, _req: Request, _res: Response, next: NextFunction) {
  const context = tenantContextStorage.getStore();
  if (context) {
    context.finish(false).finally(() => next(err));
  } else {
    next(err);
  }
}
