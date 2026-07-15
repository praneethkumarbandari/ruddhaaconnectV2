import { pool, query } from "../db/pool.ts";

/**
 * Looks up the one account (if any) holding a given special role —
 * e.g. getAccountBySpecialRole("tds_payable") finds whichever ledger
 * account was marked as THE TDS Payable account in Chart of Accounts.
 *
 * Replaces the old pattern of reading a dedicated column out of
 * portal_config (e.g. tds_payable_account_code) — that required a
 * second, disconnected settings screen kept in sync by hand. This
 * reads the same information directly off the account it actually
 * describes, enforced unique by a partial index (see
 * schema-account-special-role.sql) so at most one account can ever
 * hold a given role at a time.
 */
export async function getAccountBySpecialRole(role: string): Promise<{ id: number; account_code: string; account_name: string } | null> {
  const { rows } = await query(
    `select id, account_code, account_name from chart_of_accounts where special_role = $1 and is_active = true limit 1`,
    [role],
  );
  return rows[0] ?? null;
}
