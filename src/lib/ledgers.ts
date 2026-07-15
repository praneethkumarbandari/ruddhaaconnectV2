import { query } from "../db/pool.ts";
import { getControlAccountCode } from "./control-accounts.ts";

/**
 * FIX (menu/UX restructure): Journal Entry, General Ledger, Receipts,
 * and Payments were all built to show raw chart_of_accounts rows in
 * their account pickers — including "Sundry Debtors"/"Sundry
 * Creditors" as one single, undifferentiated line each. That's
 * correct as an accounting GROUP, but wrong as something a user picks
 * from a dropdown: selecting "Sundry Debtors" tells you nothing about
 * WHICH customer, and every individual bank account was similarly
 * invisible behind whatever generic COA code it happened to be mapped
 * to.
 *
 * This is the one place that assembles the real, pickable list: every
 * ordinary chart_of_accounts account a user should be able to post to
 * directly (Sales, Salary Expense, etc.), PLUS one row per customer,
 * one row per vendor, and one row per real bank account — each
 * carrying whatever the posting engine actually needs (accountCode,
 * and partyType/partyId for customers/vendors) so the caller never
 * has to know the difference between "a ledger" and "an account
 * code + a party tag".
 *
 * Deliberately excludes from the plain COA list:
 *   - TRADE_DEBTORS / TRADE_CREDITORS themselves (every customer/
 *     vendor row already represents a postable line against these
 *     control accounts — showing the bare control account too would
 *     let someone post an untagged, partyless entry against it,
 *     which is exactly the "who does this money belong to" gap the
 *     party-tagged lines exist to close)
 *   - any chart_of_accounts row that IS a bank account's own ledger
 *     account (bank_accounts.coa_id) — those already appear as their
 *     real, named bank account instead, once each, not twice.
 *
 * Resolves the same two control-account roles every posting module
 * resolves through src/lib/control-accounts.ts — the single shared
 * source, not a local copy of the account codes.
 */

export type Ledger = {
  kind: "coa" | "customer" | "vendor" | "bank";
  accountCode: string;
  partyType?: "customer" | "vendor";
  partyId?: number;
  label: string;
};

export async function listLedgers(): Promise<Ledger[]> {
  const [tradeDebtors, tradeCreditors] = await Promise.all([
    getControlAccountCode("sundry_debtors"),
    getControlAccountCode("sundry_creditors"),
  ]);

  const [{ rows: coa }, { rows: customers }, { rows: vendors }, { rows: banks }] = await Promise.all([
    query(
      `select account_code, account_name
       from chart_of_accounts
       where is_active = true
         and account_code not in ($1, $2)
         and id not in (select coa_id from bank_accounts)
       order by account_code`,
      [tradeDebtors, tradeCreditors],
    ),
    query(`select id, customer_name from customers where is_active = true order by customer_name`),
    query(`select id, vendor_name from vendors where is_active = true order by vendor_name`),
    query(
      `select coa.account_code, ba.account_name, ba.bank_name, ba.account_number
       from bank_accounts ba
       join chart_of_accounts coa on coa.id = ba.coa_id
       order by ba.account_name`,
    ),
  ]);

  const ledgers: Ledger[] = [];

  for (const a of coa) {
    ledgers.push({ kind: "coa", accountCode: a.account_code, label: `${a.account_name} (${a.account_code})` });
  }
  for (const c of customers) {
    ledgers.push({
      kind: "customer",
      accountCode: tradeDebtors,
      partyType: "customer",
      partyId: c.id,
      label: `${c.customer_name} (Customer)`,
    });
  }
  for (const v of vendors) {
    ledgers.push({
      kind: "vendor",
      accountCode: tradeCreditors,
      partyType: "vendor",
      partyId: v.id,
      label: `${v.vendor_name} (Vendor)`,
    });
  }
  for (const b of banks) {
    const suffix = b.bank_name
      ? ` (${b.bank_name}${b.account_number ? " — " + String(b.account_number).slice(-4) : ""})`
      : "";
    ledgers.push({ kind: "bank", accountCode: b.account_code, label: `${b.account_name}${suffix}` });
  }

  return ledgers.sort((a, b) => a.label.localeCompare(b.label));
}
