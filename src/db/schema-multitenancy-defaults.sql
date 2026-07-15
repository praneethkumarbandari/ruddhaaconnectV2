-- ============================================================
-- MULTI-TENANCY: AUTO-FILL tenant_id ON INSERT
-- ============================================================
-- FIX: schema-multitenancy.sql made every table READABLE only
-- for the current tenant (via RLS policies keyed off
-- current_setting('app.tenant_id')), but did nothing to help
-- WRITES -- no INSERT statement anywhere in the codebase was
-- ever written to pass tenant_id explicitly, since tenant_id
-- did not exist when those insert statements were first
-- written. Every one of them would fail today with a NOT NULL
-- violation the moment tenant_id has no default.
--
-- Rather than edit dozens of INSERT statements across the whole
-- codebase (error-prone, and easy to miss one), this gives each
-- tenant_id column a DEFAULT that reads the exact same
-- per-request setting tenantContextMiddleware already applies
-- via set_config('app.tenant_id', ..., true) -- so any INSERT
-- that does not explicitly supply tenant_id gets the correct
-- value automatically, for free, at the database level.
--
-- Falls back to NULL (not an error) when no tenant context is
-- set -- e.g. setup.ts, migration scripts, or anything run
-- outside the HTTP request pipeline. Those callers already
-- pass tenant_id explicitly (see setup.ts), which always
-- overrides a column default -- this is purely a safety net for
-- the many callers that do NOT, not a replacement for explicit
-- passing where that already happens.
-- ============================================================

alter table approval_hierarchies alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table approval_hierarchy_levels alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table attendance_correction_requests alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table attendance_import_batches alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table attendance_import_rows alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table attendance_locks alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table attendance_mapping_templates alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table attendance_policies alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table attendance_records alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table attendance_statuses alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table audit_log alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table bank_accounts alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table bank_import_batches alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table bank_import_rows alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table bank_transactions alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table branches alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table chart_of_accounts alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table cost_centers alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table costing_records alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table credit_notes alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table crm_activities alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table crm_followups alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table crm_leads alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table customer_requests alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table customers alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table debit_notes alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table departments alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table designations alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_addresses alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_assets alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_bank_details alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_certifications alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_contact_details alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_documents alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_education alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_emergency_contacts alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_experience alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_loans alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_master alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_salary_structure_assignments alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_shift_assignments alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_skills alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employee_statutory_details alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employees alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table employment_types alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table financial_years alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table holidays alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table inventory alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table inventory_transactions alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table journal_entries alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table journal_entry_lines alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table leave_balance_transactions alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table leave_policies alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table leave_requests alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table leave_types alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table leave_year_configurations alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table loan_installments alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table mapping_templates alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table numbering_sequences alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table payment_allocations alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table payments alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table payroll_account_mappings alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table payroll_line_components alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table payroll_lines alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table payroll_runs alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_activity_log alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_budget alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_budget_versions alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_categories alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_documents alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_estimates alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_members alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_milestones alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_notes alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table project_tasks alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table projects alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table purchase_invoice_lines alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table purchase_invoices alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table receipt_allocations alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table receipts alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table reimbursement_claims alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table salary_components alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table salary_structure_components alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table salary_structures alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table sales_invoice_lines alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table sales_invoices alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table shift_overrides alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table shifts alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table user_roles alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table vendors alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
alter table weekly_off_configurations alter column tenant_id set default nullif(current_setting('app.tenant_id', true), '')::bigint;
