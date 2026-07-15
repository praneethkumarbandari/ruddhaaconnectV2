-- ============================================================
-- MULTI-TENANCY: ENFORCEMENT (FORCE ROW LEVEL SECURITY)
-- ============================================================
-- DELIBERATELY NOT part of `npm run migrate` -- this is a
-- manual, one-time, LAST step, run ONLY after every one of the
-- 46 route files that used to read via bare pool.query() has
-- been migrated onto query()/withTransaction() (see
-- src/db/tenant-context.ts, src/middleware/tenant-context.ts)
-- AND test:all passes AND
-- test/multitenancy-isolation-regression.ts passes.
--
-- Applying this before that point reproduces the exact failure
-- this whole effort was designed to avoid: some requests
-- (whichever routes are still on bare pool.query()) would
-- suddenly see zero rows once their table's owner-bypass is
-- removed, not real isolation -- just broken reads, silently,
-- for whichever routes hadn't been migrated yet.
--
-- Run manually: psql "$DATABASE_URL" -f src/db/schema-multitenancy-enforce.sql
-- ============================================================

alter table approval_hierarchies force row level security;
alter table approval_hierarchy_levels force row level security;
alter table attendance_correction_requests force row level security;
alter table attendance_import_batches force row level security;
alter table attendance_import_rows force row level security;
alter table attendance_locks force row level security;
alter table attendance_mapping_templates force row level security;
alter table attendance_policies force row level security;
alter table attendance_records force row level security;
alter table attendance_statuses force row level security;
alter table audit_log force row level security;
alter table bank_accounts force row level security;
alter table bank_import_batches force row level security;
alter table bank_import_rows force row level security;
alter table bank_transactions force row level security;
alter table branches force row level security;
alter table chart_of_accounts force row level security;
alter table cost_centers force row level security;
alter table costing_records force row level security;
alter table credit_notes force row level security;
alter table crm_activities force row level security;
alter table crm_followups force row level security;
alter table crm_leads force row level security;
alter table customer_requests force row level security;
alter table customers force row level security;
alter table debit_notes force row level security;
alter table departments force row level security;
alter table designations force row level security;
alter table employee_addresses force row level security;
alter table employee_assets force row level security;
alter table employee_bank_details force row level security;
alter table employee_certifications force row level security;
alter table employee_contact_details force row level security;
alter table employee_documents force row level security;
alter table employee_education force row level security;
alter table employee_emergency_contacts force row level security;
alter table employee_experience force row level security;
alter table employee_loans force row level security;
alter table employee_master force row level security;
alter table employee_salary_structure_assignments force row level security;
alter table employee_shift_assignments force row level security;
alter table employee_skills force row level security;
alter table employee_statutory_details force row level security;
alter table employees force row level security;
alter table employment_types force row level security;
alter table financial_years force row level security;
alter table holidays force row level security;
alter table inventory force row level security;
alter table inventory_transactions force row level security;
alter table journal_entries force row level security;
alter table journal_entry_lines force row level security;
alter table leave_balance_transactions force row level security;
alter table leave_policies force row level security;
alter table leave_requests force row level security;
alter table leave_types force row level security;
alter table leave_year_configurations force row level security;
alter table loan_installments force row level security;
alter table mapping_templates force row level security;
alter table numbering_sequences force row level security;
alter table payment_allocations force row level security;
alter table payments force row level security;
alter table payroll_account_mappings force row level security;
alter table payroll_line_components force row level security;
alter table payroll_lines force row level security;
alter table payroll_runs force row level security;
alter table portal_config force row level security;
alter table project_activity_log force row level security;
alter table project_budget force row level security;
alter table project_budget_versions force row level security;
alter table project_categories force row level security;
alter table project_documents force row level security;
alter table project_estimates force row level security;
alter table project_members force row level security;
alter table project_milestones force row level security;
alter table project_notes force row level security;
alter table project_tasks force row level security;
alter table projects force row level security;
alter table purchase_invoice_lines force row level security;
alter table purchase_invoices force row level security;
alter table receipt_allocations force row level security;
alter table receipts force row level security;
alter table reimbursement_claims force row level security;
alter table salary_components force row level security;
alter table salary_structure_components force row level security;
alter table salary_structures force row level security;
alter table sales_invoice_lines force row level security;
alter table sales_invoices force row level security;
alter table shift_overrides force row level security;
alter table shifts force row level security;
alter table tds_deductions force row level security;
alter table user_roles force row level security;
alter table vendors force row level security;
alter table weekly_off_configurations force row level security;
