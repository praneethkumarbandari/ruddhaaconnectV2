import type { Request } from "express";

/**
 * Maps a request's subdomain directly to a schema name — by
 * convention, they're the same string (e.g.
 * dwaraka.ruddhaaconnect.in -> schema "dwaraka"). This is what makes
 * login itself schema-aware: unlike the old numeric-tenant-id model
 * (where login looked up a user by email/username ACROSS all
 * tenants, then learned their tenant from the row it found), a
 * schema-per-tenant model can't do that — there's no cross-schema
 * lookup without knowing the schema first. The subdomain the request
 * arrived on IS that "know the schema first" signal.
 *
 * Deliberately a plain function, not a hardcoded list of the 4
 * known schemas (test, dwaraka, care, ajay) — onboarding a 5th
 * business should never require touching this file. Validates
 * against the exact same naming rule create_tenant_schema() enforces
 * (lowercase letters/numbers/underscores, starting with a letter),
 * so a malformed or malicious subdomain fails here, not several
 * layers deeper as an obscure SQL error.
 *
 * FIX (real bug, found in production): the first version of this
 * function fell back to "test" only when the hostname had fewer than
 * 3 labels. That broke the moment this actually deployed — Netlify's
 * own default URL, ruddhaa.netlify.app, ALSO has exactly 3 labels
 * ("ruddhaa", "netlify", "app"), so it was being read as if "ruddhaa"
 * were a real company subdomain, and the app tried to query a schema
 * called "ruddhaa" that has never existed (error: relation
 * "ruddhaa.employees" does not exist). Label counting alone can't
 * distinguish "a real subdomain of our own domain" from "some other
 * 3-label hostname entirely" — checking against the actual production
 * root domain does.
 */
const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// The one real root domain subdomains are ever resolved under. Every
// other hostname (Netlify's own *.netlify.app default, localhost,
// deploy previews, custom domains you haven't wired up as a company
// subdomain yet) falls back to "test" — not because it has "enough"
// labels, but because it isn't actually a subdomain of THIS domain.
const PRODUCTION_ROOT_DOMAIN = "ruddhaaconnect.in";
const DEV_FALLBACK_SCHEMA = "test";

export function resolveSchemaFromRequest(req: Request): string {
  const host = (req.hostname || "").toLowerCase();

  if (!host.endsWith("." + PRODUCTION_ROOT_DOMAIN)) {
    return DEV_FALLBACK_SCHEMA;
  }

  // "dwaraka.ruddhaaconnect.in" minus ".ruddhaaconnect.in" -> "dwaraka"
  const candidate = host.slice(0, -(PRODUCTION_ROOT_DOMAIN.length + 1));
  if (!SCHEMA_NAME_PATTERN.test(candidate)) {
    throw new Error(`Invalid subdomain "${candidate}" — cannot map to a schema name.`);
  }
  return candidate;
}
