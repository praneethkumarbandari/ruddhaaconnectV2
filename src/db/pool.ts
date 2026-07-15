import pg from "pg";
import { getTenantContext } from "./tenant-context.ts";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  // Fail loudly at boot, not silently at first query. A backend that
  // owns accounting data cannot start against an unknown database.
  throw new Error("DATABASE_URL is not set. Refusing to start.");
}

/**
 * Pool sizing note (Netlify Functions + Supabase):
 *
 * This pool is created once per function container and reused across
 * warm invocations — same pattern as any long-running Node process,
 * just with a shorter, less predictable lifetime. The one thing that
 * *does* change under Netlify Functions is that many containers can
 * run concurrently, each with its own pool — so a large `max` here
 * multiplies across containers in a way it never did as a single
 * Express server. `max: 3` per container, combined with pointing
 * DATABASE_URL at Supabase's connection pooler (not the direct
 * connection), keeps total backend-connection usage bounded
 * regardless of how many function containers are running.
 *
 * Supabase pooler mode: use the "Transaction" pooler (port 6543).
 * This codebase's only session-scoped pattern is `pool.connect()` +
 * BEGIN/COMMIT/ROLLBACK entirely within one withTransaction() call
 * (see below) — including the `SELECT ... FOR UPDATE` row locks in
 * number-generator.ts, which only need to hold for the lifetime of a
 * single transaction. Nothing here uses session-level state (advisory
 * locks outside a transaction, prepared statements across requests,
 * SET commands outside a transaction) that transaction-mode pooling
 * would break. This is exactly the pattern Supabase's Transaction
 * pooler is designed for.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: process.env.DATABASE_POOL_MAX ? Number(process.env.DATABASE_POOL_MAX) : 3,
});

export type PgClient = pg.PoolClient;

let savepointCounter = 0;

/**
 * Runs `fn` inside a database transaction. Commits on success, rolls
 * back on any thrown error — including errors thrown by the posting
 * engine's own validation (unbalanced entry, closed financial year,
 * etc.). Nothing partial is ever left committed.
 *
 * FIX (multi-tenancy): this used to always open its own, brand-new
 * connection via pool.connect(), completely independent of whatever
 * tenant context the request might already have. That was fine before
 * tenant scoping existed, but would be a real, silent security bug
 * once RLS is enforced: a call to withTransaction() from inside a
 * tenant-scoped request would run on a SECOND connection that never
 * had app.tenant_id set on it at all, and depending on the exact RLS
 * policy shape, either fail every row or — worse — succeed with no
 * tenant filtering whatsoever.
 *
 * Now: if a tenant context already exists (see
 * middleware/tenant-context.ts — true for every authenticated HTTP
 * request), this reuses that SAME client instead of opening a second
 * one, wrapped in a SAVEPOINT rather than a new BEGIN (Postgres has no
 * true nested transactions) — the exact same SAVEPOINT pattern already
 * proven correct elsewhere in this codebase (see project-budget.ts's
 * and inventory.ts's own concurrency-retry fixes) — so an error here
 * rolls back only this unit of work via ROLLBACK TO SAVEPOINT, while
 * the outer request-level transaction (and its tenant_id setting)
 * remains untouched and still commits normally when the request
 * finishes successfully.
 *
 * If NO tenant context exists (a script, a test, a migration runner —
 * anything not running inside the HTTP server's request pipeline),
 * this falls back to the original behavior: open its own connection,
 * BEGIN/COMMIT/ROLLBACK independently. That fallback has no tenant_id
 * set at all, which is correct for those callers — they're not
 * serving a specific tenant's request in the first place.
 */
export async function withTransaction<T>(
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const context = getTenantContext();

  if (context) {
    const savepointName = `wt_${++savepointCounter}`;
    await context.client.query(`savepoint ${savepointName}`);
    try {
      const result = await fn(context.client);
      await context.client.query(`release savepoint ${savepointName}`);
      return result;
    } catch (err) {
      await context.client.query(`rollback to savepoint ${savepointName}`);
      throw err;
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * FIX (multi-tenancy): the read-side equivalent of the problem
 * withTransaction() above solves for writes. 46 of 69 route files
 * called pool.query() directly for reads, entirely outside any
 * transaction — meaning outside any connection that would ever have
 * app.tenant_id set on it. This is the single replacement for all of
 * those call sites: inside a tenant-scoped request, it runs the query
 * on that request's own client (tenant_id already set); outside one
 * (a script, a test, a migration), it falls back to pool.query()
 * directly, identical to what every one of those call sites already
 * did before this existed.
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  const context = getTenantContext();
  if (context) {
    return context.client.query<T>(text, params);
  }
  return pool.query<T>(text, params);
}
