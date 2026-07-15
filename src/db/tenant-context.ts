import { AsyncLocalStorage } from "node:async_hooks";
import type { PgClient } from "./pool.ts";

/**
 * Why AsyncLocalStorage, not a parameter threaded through every
 * function: the alternative to this file is changing the signature
 * of every route handler and every lib function that queries the
 * database — hundreds of call sites — to accept and pass through a
 * client explicitly. AsyncLocalStorage lets the request's tenant-
 * scoped client be available to any code running within that
 * request's async call chain (including code many layers deep) without
 * changing what any of those functions look like. This is a real
 * behavior change (see pool.ts's withTransaction() and this file's own
 * getContextClient() helper for where it actually takes effect), not
 * invisible magic — every place that reads from this context is
 * documented at that call site.
 */
export type TenantContext = {
  client: PgClient;
  /**
   * FIX (architecture pivot): this was `tenantId: string`, a numeric
   * tenant_id value used by set_config('app.tenant_id', ...) against
   * Row-Level Security policies on shared tables. The business owner's
   * actual, consistently-stated requirement was separate tables per
   * company — not a shared table with a hidden column — so the real
   * isolation boundary is now a Postgres schema per company, selected
   * via SET search_path, not a config value RLS policies read.
   * Renamed to reflect what it actually holds now, rather than leave
   * a numeric-sounding name on something that's now a schema
   * identifier — exactly the kind of name/reality drift this
   * codebase has otherwise been careful to avoid.
   */
  schemaName: string;
  /**
   * Finalizes the whole request's transaction exactly once — shared
   * between the success path (res.on('finish') in the middleware) and
   * the error path (tenantContextErrorHandler), specifically so a
   * request that errors doesn't ALSO get a second, conflicting
   * commit/rollback attempt from the success path once the response
   * eventually completes (which it always does, even after an error).
   */
  finish: (commit: boolean) => Promise<void>;
};

export const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

/** Returns the current request's tenant context, or undefined if none exists (no context = not running inside a tenant-scoped request — e.g. a public route, or a script/test run outside the HTTP server entirely). */
export function getTenantContext(): TenantContext | undefined {
  return tenantContextStorage.getStore();
}
