import { getAccountBySpecialRole } from "./chart-of-accounts.ts";

/**
 * FIX (single source of truth): TRADE_DEBTORS = "1200" and
 * TRADE_CREDITORS = "2100" used to be copy-pasted as their own local
 * constant in five different files (receipts.ts, payments.ts,
 * sales.ts, purchases.ts, notes.ts) — five separate places that would
 * all need to agree, by hand, if a control account code ever changed.
 * This is the one place. Every module that needs a control account
 * code goes through getControlAccountCode() here instead of hardcoding
 * its own copy.
 *
 * Resolution order: prefer whatever chart_of_accounts row has actually
 * been marked with the matching special_role (see
 * schema-account-special-role.sql / getAccountBySpecialRole) — that's
 * the real, current, user-editable answer. Fall back to the original
 * seed-data codes only when no account has been marked yet (fresh
 * install, or a business that hasn't touched Chart of Accounts'
 * special-role field at all) — same codes this codebase has already
 * shipped with, kept as the fallback rather than silently changed.
 *
 * Role names deliberately match the SPECIAL_ROLES list already live in
 * routes/chart-of-accounts.ts — "sundry_debtors"/"sundry_creditors",
 * NOT "trade_debtors"/"trade_creditors". Catching this mismatch here
 * mattered: the account-code VALUES ("1200"/"2100") were consistent
 * across every file, but if this module's role NAMES didn't match the
 * one enum users actually pick from in Chart of Accounts, every
 * special_role override would silently never match, and every posting
 * would quietly fall back to the hardcoded default forever — the
 * "Trade Debtors" vs "Sundry Debtors" naming split flagged in the
 * review, closed here rather than propagated into new code.
 * "bank" isn't yet an accepted special_role value in that list at all
 * (only "cash" is) — so getControlAccountCode("bank") will always use
 * the fallback until "bank" is added there too; noted, not silently
 * hidden.
 */
const FALLBACK_CODES = {
  sundry_debtors: "1200",
  sundry_creditors: "2100",
  cash: "1000",
  bank: "1100",
} as const;

export type ControlAccountRole = keyof typeof FALLBACK_CODES;

export async function getControlAccountCode(role: ControlAccountRole): Promise<string> {
  const account = await getAccountBySpecialRole(role);
  return account?.account_code ?? FALLBACK_CODES[role];
}

/**
 * Fallback codes exposed directly for the rare synchronous case (e.g.
 * building a static UI label). Prefer getControlAccountCode() for
 * anything that actually posts or reads ledger data — a hardcoded
 * fallback read directly bypasses the special_role override entirely.
 */
export const CONTROL_ACCOUNT_FALLBACKS = FALLBACK_CODES;
