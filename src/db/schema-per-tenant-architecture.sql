-- ============================================================
-- ARCHITECTURAL PIVOT: schema-per-tenant, not shared-tables + RLS
-- ============================================================
-- FIX (real, deliberate architecture change, not a bug fix): every
-- prior migration this session (schema-multitenancy.sql, schema-
-- multitenancy-defaults.sql, schema-financial-years-tenant-scope-
-- fix.sql, schema-master-data-tenant-scope-fix.sql) built a SHARED-
-- TABLES model — one physical customers table, one sales_invoices
-- table, with a tenant_id column and Row-Level Security policies
-- deciding who sees which rows.
--
-- The business owner's actual, consistently-stated requirement was
-- different: separate tables per company, identifiable by company
-- code, so that backing up or extracting one company's data is a
-- clean, physical operation — not a per-row filter across 91 shared
-- tables. That is a genuinely different architecture (schema-per-
-- tenant), not an extension of the RLS work.
--
-- This file does NOT undo the RLS work — those policies are harmless
-- if unused, and the connection-scoping (query()/withTransaction())
-- work absolutely carries over unchanged, since Postgres resolves
-- unqualified table names via search_path regardless of which model
-- is in use. What changes is: instead of setting app.tenant_id and
-- relying on a WHERE-clause-equivalent RLS policy, the app now sets
-- search_path to the requesting company's own schema, and every
-- existing bare table reference (select * from customers, not
-- select * from public.customers — confirmed no code hardcodes the
-- public. prefix anywhere) transparently resolves to that company's
-- own physically separate table.
--
-- Two Postgres details that would otherwise silently break this,
-- both handled explicitly below:
--   1. CREATE TABLE ... (LIKE public.x INCLUDING ALL) does NOT carry
--      over foreign key constraints — documented Postgres behavior.
--      Every FK on every cloned table is introspected from the
--      source and explicitly recreated pointing at the new schema.
--   2. A cloned bigserial column's default (nextval('public.x_id_seq'))
--      would otherwise keep pointing at the ORIGINAL public sequence
--      — meaning every tenant schema's "new" id column would silently
--      share ONE counter with every other tenant, a real, dangerous
--      bug (not just an inefficiency: it would leak information about
--      how many rows other tenants have, and eventually let two
--      tenants' foreign-key-referenced ids collide in application
--      logic that assumes ids are schema-local). Every such column
--      gets its own new, independently-owned sequence in the new
--      schema instead.
--
-- Also drops the tenant_id column (and the tenant-scoped unique
-- constraints built around it in schema-master-data-tenant-scope-
-- fix.sql) from every cloned table — physical schema separation IS
-- the isolation boundary now, tenant_id would be pure vestigial cruft
-- going forward, and leaving it would just be confusing to the next
-- person reading this schema.

create or replace function create_tenant_schema(p_schema_name text) returns void as $$
declare
  tbl text;
  tenant_tables text[] := array['approval_hierarchies', 'approval_hierarchy_levels', 'attendance_correction_requests', 'attendance_import_batches', 'attendance_import_rows', 'attendance_locks', 'attendance_mapping_templates', 'attendance_policies', 'attendance_records', 'attendance_statuses', 'audit_log', 'bank_accounts', 'bank_import_batches', 'bank_import_rows', 'bank_transactions', 'branches', 'chart_of_accounts', 'cost_centers', 'costing_records', 'credit_notes', 'crm_activities', 'crm_followups', 'crm_leads', 'customer_requests', 'customers', 'debit_notes', 'departments', 'designations', 'employee_addresses', 'employee_assets', 'employee_bank_details', 'employee_certifications', 'employee_contact_details', 'employee_documents', 'employee_education', 'employee_emergency_contacts', 'employee_experience', 'employee_loans', 'employee_master', 'employee_salary_structure_assignments', 'employee_shift_assignments', 'employee_skills', 'employee_statutory_details', 'employees', 'employment_types', 'financial_years', 'holidays', 'inventory', 'inventory_transactions', 'journal_entries', 'journal_entry_lines', 'leave_balance_transactions', 'leave_policies', 'leave_requests', 'leave_types', 'leave_year_configurations', 'loan_installments', 'mapping_templates', 'numbering_sequences', 'payment_allocations', 'payments', 'payroll_account_mappings', 'payroll_line_components', 'payroll_lines', 'payroll_runs', 'portal_config', 'project_activity_log', 'project_budget', 'project_budget_versions', 'project_categories', 'project_documents', 'project_estimates', 'project_members', 'project_milestones', 'project_notes', 'project_tasks', 'projects', 'purchase_invoice_lines', 'purchase_invoices', 'receipt_allocations', 'receipts', 'reimbursement_claims', 'salary_components', 'salary_structure_components', 'salary_structures', 'sales_invoice_lines', 'sales_invoices', 'shift_overrides', 'shifts', 'tds_deductions', 'user_roles', 'vendors', 'weekly_off_configurations'];
  fk record;
  seq_col record;
  new_seq_name text;
  old_default text;
begin
  if p_schema_name !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'Schema name must be lowercase letters, numbers, and underscores only, starting with a letter. Got: %', p_schema_name;
  end if;

  execute format('create schema if not exists %I', p_schema_name);

  -- Pass 1: clone table structure (columns, defaults, indexes, CHECK
  -- constraints, NOT NULL) for every table that actually exists in
  -- public. Two tables (portal_config, tds_deductions) are known to
  -- be missing on some environments — skipped with a notice, not an
  -- error, matching this codebase's existing defensive-migration style.
  foreach tbl in array tenant_tables loop
    if to_regclass('public.' || tbl) is null then
      raise notice 'Skipping % — does not exist in public schema on this environment.', tbl;
      continue;
    end if;
    execute format('create table if not exists %I.%I (like public.%I including all)', p_schema_name, tbl, tbl);
  end loop;

  -- Pass 2: give every bigserial-style column its own independent
  -- sequence in the new schema, instead of silently sharing the
  -- original public sequence across every tenant.
  for seq_col in
    select c.relname as table_name, a.attname as column_name
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    join pg_class c on c.oid = d.adrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = p_schema_name
      and c.relname = any(tenant_tables)
      and pg_get_expr(d.adbin, d.adrelid) like 'nextval(%'
  loop
    new_seq_name := seq_col.table_name || '_' || seq_col.column_name || '_seq';
    execute format('create sequence if not exists %I.%I', p_schema_name, new_seq_name);
    execute format(
      'alter table %I.%I alter column %I set default nextval(%L)',
      p_schema_name, seq_col.table_name, seq_col.column_name,
      p_schema_name || '.' || new_seq_name
    );
    execute format(
      'alter sequence %I.%I owned by %I.%I.%I',
      p_schema_name, new_seq_name, p_schema_name, seq_col.table_name, seq_col.column_name
    );
  end loop;

  -- Pass 3: recreate every foreign key, pointing at the new schema's
  -- own copies of the referenced tables — LIKE INCLUDING ALL does not
  -- carry these over at all, by design, so this is not optional.
  for fk in
    select
      con.conname,
      cl.relname as table_name,
      con.conkey,
      con.confkey,
      cl2.relname as ref_table,
      pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_class cl2 on cl2.oid = con.confrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where con.contype = 'f'
      and n.nspname = 'public'
      and cl.relname = any(tenant_tables)
      and cl2.relname = any(tenant_tables)
  loop
    begin
      execute format(
        'alter table %I.%I add constraint %I %s',
        p_schema_name, fk.table_name, fk.conname,
        -- pg_get_constraintdef() returns the definition with an
        -- unqualified referenced-table name (e.g. "FOREIGN KEY
        -- (customer_id) REFERENCES customers(id)") as long as the
        -- session calling this function has ordinary default
        -- search_path — true for a normal migration run. This
        -- explicitly rewrites that bare name to point at the new
        -- schema's own copy of the table, since without this the FK
        -- would otherwise still point back at public.customers.
        replace(fk.def, 'REFERENCES ' || fk.ref_table, 'REFERENCES ' || p_schema_name || '.' || fk.ref_table)
      );
    exception when duplicate_object then
      raise notice 'FK % already exists on %.%, skipping.', fk.conname, p_schema_name, fk.table_name;
    end;
  end loop;

  -- Pass 4: drop tenant_id — physical schema separation is the
  -- isolation boundary now, this column and the tenant-scoped unique
  -- constraints built around it in an earlier migration are vestigial.
  foreach tbl in array tenant_tables loop
    if to_regclass(p_schema_name || '.' || tbl) is not null then
      execute format('alter table %I.%I drop column if exists tenant_id', p_schema_name, tbl);
    end if;
  end loop;

  raise notice 'Tenant schema % created with % tables.', p_schema_name, array_length(tenant_tables, 1);
end;
$$ language plpgsql;
