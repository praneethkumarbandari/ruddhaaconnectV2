-- ============================================================
-- PREVENT DUPLICATE / UNLINKED ACCOUNTING MASTERS
-- ============================================================
-- FIX (real gap): bank_accounts.coa_id had a foreign key but no
-- UNIQUE constraint — nothing stopped two different bank account rows
-- from pointing at the SAME chart_of_accounts row. That's a genuine
-- duplicate-master risk: journal_entry_lines posted against that
-- shared account_id could never be attributed to one specific bank
-- account over the other, silently corrupting per-account reporting
-- (General Ledger, Bank & Cash) the moment it happened. Every bank
-- account must be linked to exactly ONE ledger, and every ledger to
-- at most one bank account.
--
-- DEPLOYMENT SAFETY: this constraint can only be added if your real,
-- existing data doesn't already violate it. Rather than let a bare
-- ALTER TABLE fail with a generic Postgres constraint-violation error
-- (which doesn't tell you WHICH rows are the problem), this checks
-- first and raises a clear, actionable message naming the exact
-- conflicting bank_accounts ids if any exist — fix those rows, then
-- re-run this file.
do $$
declare
  conflict_count int;
  conflict_list text;
begin
  select count(*), string_agg(coa_id::text || ' (bank account ids: ' || ids || ')', '; ')
  into conflict_count, conflict_list
  from (
    select coa_id, string_agg(id::text, ', ') as ids
    from bank_accounts
    group by coa_id
    having count(*) > 1
  ) dupes;

  if conflict_count > 0 then
    raise exception 'Cannot add bank_accounts_coa_id_unique: % ledger(s) are currently linked to more than one bank account: %. Fix these rows (each ledger must back exactly one bank account) before re-running this migration.', conflict_count, conflict_list;
  end if;
end $$;

alter table bank_accounts drop constraint if exists bank_accounts_coa_id_unique;
alter table bank_accounts add constraint bank_accounts_coa_id_unique unique (coa_id);

-- Same safety check for the account-number uniqueness rule below.
do $$
declare
  conflict_count int;
  conflict_list text;
begin
  select count(*), string_agg(bank_name || ' / ' || account_number || ' (bank account ids: ' || ids || ')', '; ')
  into conflict_count, conflict_list
  from (
    select bank_name, account_number, string_agg(id::text, ', ') as ids
    from bank_accounts
    where account_number is not null and is_active = true
    group by bank_name, account_number
    having count(*) > 1
  ) dupes;

  if conflict_count > 0 then
    raise exception 'Cannot add idx_bank_accounts_no_duplicate_account_number: % bank account(s) are duplicated by (bank_name, account_number): %. Deactivate or correct the duplicates before re-running this migration.', conflict_count, conflict_list;
  end if;
end $$;

-- Prevents the same real, physical bank account being entered twice
-- by accident (same bank, same account number) — scoped to rows that
-- actually HAVE an account number, since Cash/Petty Cash accounts
-- legitimately have none and shouldn't be forced into this check.
drop index if exists idx_bank_accounts_no_duplicate_account_number;
create unique index idx_bank_accounts_no_duplicate_account_number
  on bank_accounts (bank_name, account_number)
  where account_number is not null and is_active = true;

