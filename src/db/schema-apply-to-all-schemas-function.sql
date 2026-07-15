-- ============================================================
-- REAL FIX for a real, recurring mistake: per-tenant migrations
-- (anything touching chart_of_accounts, portal_config, customers,
-- etc.) need to run against BOTH "public" (so create_tenant_schema()
-- clones the change into every future company) AND every already-
-- existing tenant schema (so current companies' data has it too).
-- Up to this point, that's been done by hand, one migration at a
-- time, by figuring out which schemas need it — exactly the kind of
-- thing that gets missed. This makes it automatic and impossible to
-- half-do going forward.
-- ============================================================

create or replace function apply_to_all_schemas(ddl text) returns void as $$
declare
  schema_name text;
begin
  -- 1. Always apply to public first — this is what create_tenant_
  -- schema() clones FROM, so every company onboarded after this point
  -- automatically inherits the change.
  execute ddl;

  -- 2. Then apply the same statement again to every already-existing
  -- tenant schema, so current companies' real data gets it too, not
  -- just future ones. Loops over the real tenants registry — not a
  -- hardcoded schema list — so this keeps working correctly as more
  -- companies (dwaraka, care, ajay, and whatever comes after) get
  -- onboarded, with zero code changes needed here.
  for schema_name in select tenant_code from tenants where is_active loop
    execute format('set local search_path to %I, public', schema_name);
    execute ddl;
    execute 'set local search_path to public';
  end loop;
end;
$$ language plpgsql;

comment on function apply_to_all_schemas(text) is
  'Runs a DDL/DML statement against public AND every existing tenant schema. '
  'Use this for any future migration touching a per-tenant table (chart_of_accounts, '
  'portal_config, customers, employees, etc.) instead of running it by hand against '
  'one schema at a time. Example: select apply_to_all_schemas(''alter table portal_config add column if not exists foo text'');';
