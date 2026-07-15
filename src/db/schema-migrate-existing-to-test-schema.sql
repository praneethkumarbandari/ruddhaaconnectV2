-- ============================================================
-- ONE-TIME: move existing data into its own "test" schema
-- ============================================================
-- FIX: for the existing DEFAULT tenant's real, already-live data,
-- cloning structure and copying rows (the approach create_tenant_
-- schema() uses for brand-new, empty pilot schemas) would be the
-- WRONG, riskier choice here — it means re-inserting every row,
-- re-establishing every sequence's current value, and re-verifying
-- every FK, all copy operations that could subtly go wrong with real
-- data on the line.
--
-- ALTER TABLE ... SET SCHEMA is safer and simpler for this specific
-- case: it's a metadata-only move, not a copy. Every row stays
-- exactly as it is, every owned sequence moves with its table
-- automatically, and every foreign key keeps working unchanged,
-- since Postgres constraints reference tables by internal OID, not
-- by schema-qualified name — moving every referencing AND every
-- referenced table together (all 93, in one transaction) means
-- nothing is left half-moved.
--
-- Run this ONCE. Running it twice is harmless (the second run finds
-- nothing left in public to move and does nothing), but it should
-- never run on an environment where public.* has already been used
-- to bootstrap a genuinely different tenant's data in the meantime.

do $$
declare
  tbl text;
  tenant_tables text[] := array['approval_hierarchies', 'approval_hierarchy_levels', 'attendance_correction_requests', 'attendance_import_batches', 'attendance_import_rows', 'attendance_locks', 'attendance_mapping_templates', 'attendance_policies', 'attendance_records', 'attendance_statuses', 'audit_log', 'bank_accounts', 'bank_import_batches', 'bank_import_rows', 'bank_transactions', 'branches', 'chart_of_accounts', 'cost_centers', 'costing_records', 'credit_notes', 'crm_activities', 'crm_followups', 'crm_leads', 'customer_requests', 'customers', 'debit_notes', 'departments', 'designations', 'employee_addresses', 'employee_assets', 'employee_bank_details', 'employee_certifications', 'employee_contact_details', 'employee_documents', 'employee_education', 'employee_emergency_contacts', 'employee_experience', 'employee_loans', 'employee_master', 'employee_salary_structure_assignments', 'employee_shift_assignments', 'employee_skills', 'employee_statutory_details', 'employees', 'employment_types', 'financial_years', 'holidays', 'inventory', 'inventory_transactions', 'journal_entries', 'journal_entry_lines', 'leave_balance_transactions', 'leave_policies', 'leave_requests', 'leave_types', 'leave_year_configurations', 'loan_installments', 'mapping_templates', 'numbering_sequences', 'payment_allocations', 'payments', 'payroll_account_mappings', 'payroll_line_components', 'payroll_lines', 'payroll_runs', 'portal_config', 'project_activity_log', 'project_budget', 'project_budget_versions', 'project_categories', 'project_documents', 'project_estimates', 'project_members', 'project_milestones', 'project_notes', 'project_tasks', 'projects', 'purchase_invoice_lines', 'purchase_invoices', 'receipt_allocations', 'receipts', 'reimbursement_claims', 'salary_components', 'salary_structure_components', 'salary_structures', 'sales_invoice_lines', 'sales_invoices', 'shift_overrides', 'shifts', 'tds_deductions', 'user_roles', 'vendors', 'weekly_off_configurations'];
begin
  create schema if not exists test;

  foreach tbl in array tenant_tables loop
    if to_regclass('public.' || tbl) is not null then
      execute format('alter table public.%I set schema test', tbl);
    else
      raise notice 'Skipping % — does not exist in public on this environment.', tbl;
    end if;
  end loop;

  -- Same vestigial-column cleanup as create_tenant_schema() — physical
  -- schema separation is the isolation boundary now, tenant_id is no
  -- longer meaningful once every row in "test" schema unambiguously
  -- belongs to the same one company.
  --
  -- FIX (real bug, found running this against real data): unlike
  -- create_tenant_schema()'s freshly CREATE TABLE (LIKE ...)'d tables
  -- (which never carry over RLS policies at all — Postgres's LIKE
  -- clause never copies those, regardless of INCLUDING ALL), these
  -- are the ORIGINAL tables, moved via ALTER TABLE ... SET SCHEMA —
  -- which keeps everything, including the old tenant_isolation RLS
  -- policy from schema-multitenancy.sql that reads tenant_id
  -- directly. Postgres won't let you drop a column a policy still
  -- depends on. The policy has to go first.
  foreach tbl in array tenant_tables loop
    if to_regclass('test.' || tbl) is not null then
      execute format('drop policy if exists tenant_isolation on test.%I', tbl);
      execute format('alter table test.%I disable row level security', tbl);
      execute format('alter table test.%I drop column if exists tenant_id', tbl);
    end if;
  end loop;

  raise notice 'Moved existing data into the "test" schema.';
end;
$$;
