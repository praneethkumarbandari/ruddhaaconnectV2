-- FIX: replaces the "Account Mapping" section in Settings, which had
-- 17 fields but only ONE (tds_payable_account_code) was ever actually
-- read by the backend — the other 16 did nothing when filled in. This
-- puts the same information directly on the ledger account itself
-- instead of a disconnected second configuration screen: pick the
-- account's specific role once, when you create or edit it, and the
-- posting engine can ask "which account has this role?" directly.
alter table chart_of_accounts add column if not exists special_role text;

-- One business should only ever have ONE account holding each special
-- role (e.g. exactly one "this is THE TDS Payable account") — a
-- partial unique index enforces that, while leaving every ordinary
-- account (special_role is null) completely unrestricted.
drop index if exists idx_chart_of_accounts_special_role_unique;
create unique index idx_chart_of_accounts_special_role_unique
  on chart_of_accounts (tenant_id, special_role)
  where special_role is not null;
