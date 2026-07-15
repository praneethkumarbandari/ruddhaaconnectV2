-- FIX: a serious multi-tenancy gap found while building the tenant
-- onboarding endpoint. schema-multitenancy.sql added tenant_id and a
-- read-side RLS policy to financial_years, but never touched its two
-- write-side constraints:
--   1. `code text not null unique` — globally unique, not per-tenant.
--   2. `exclude using gist (daterange(...) with &&)` — blocks ANY two
--      financial years with overlapping dates, across ALL tenants.
--
-- Since virtually every Indian business uses the same April–March
-- financial year, the second tenant ever onboarded would try to
-- create a financial year with the same code ('2026-27') and the
-- same date range as the first tenant's — and Postgres would reject
-- it outright, both constraints failing, with no tenant-awareness at
-- all. This wasn't a hypothetical edge case; it was guaranteed to
-- break the very next real business onboarded.

alter table financial_years drop constraint if exists financial_years_code_key;
alter table financial_years add constraint financial_years_tenant_code_key unique (tenant_id, code);

alter table financial_years drop constraint if exists financial_years_start_date_end_date_excl;
-- Postgres auto-names exclusion constraints; the line above covers the
-- conventional name. If it was created with a different name, this
-- covers that too (safe no-op if the constraint above already matched).
do $$
declare
  r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'financial_years'::regclass and contype = 'x'
  loop
    execute format('alter table financial_years drop constraint %I', r.conname);
  end loop;
end $$;

alter table financial_years add constraint financial_years_tenant_daterange_excl
  exclude using gist (tenant_id with =, daterange(start_date, end_date, '[]') with &&);
