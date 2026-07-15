import type { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool.ts";
import { tenantContextStorage, type TenantContext } from "../db/tenant-context.ts";

/**
 * Customer-portal counterpart to middleware/tenant-context.ts, same
 * reasoning for why this is a separate file rather than a shared
 * branch: customer-portal-data.ts is mounted before the employee-
 * keyed global middleware in app.ts, so that one is never reached by
 * customer requests — see that file's own comment for the full
 * route-ordering trace.
 *
 * FIX (architecture pivot, same as tenant-context.ts): this used to
 * set app.tenant_id for an RLS policy on shared tables. Now sets
 * search_path to the customer's own company's schema instead — same
 * set_config()-with-bound-parameter approach, same AsyncLocalStorage,
 * same transaction-per-request lifecycle, just keyed off
 * req.customer?.schemaName instead of req.user?.schemaName.
 */
export async function customerTenantContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const schemaName = req.customer?.schemaName;
  if (!schemaName) {
    // Should be unreachable in practice — this middleware is mounted
    // after requireCustomerAuth, which already rejects any request
    // with no valid req.customer. Fails loudly rather than silently
    // proceeding with no schema selected, which would leave every
    // downstream query in this request resolving against public only
    // (which no longer contains any company's actual data at all).
    return next(new Error("customerTenantContextMiddleware: req.customer.schemaName is missing after requireCustomerAuth."));
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
      console.error("customerTenantContextMiddleware: failed to finalize transaction", err);
    } finally {
      client.release();
    }
  };

  try {
    await client.query("BEGIN");
    await client.query(`select set_config('search_path', $1, true)`, [`${schemaName}, public`]);
  } catch (err) {
    client.release();
    return next(err);
  }

  res.on("finish", () => {
    void finish(res.statusCode < 400);
  });

  const context: TenantContext = { client, schemaName, finish };
  tenantContextStorage.run(context, () => next());
}
