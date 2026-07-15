-- ============================================================
-- MULTI-TENANCY: SCHEMA (tenants table, tenant_id columns, RLS policies)
-- ============================================================
-- Scope: tenant_id column + RLS POLICY on every table below, but
-- deliberately NOT `FORCE ROW LEVEL SECURITY` yet -- see the note
-- at the end of this file for why, and what the follow-up
-- migration (schema-multitenancy-enforce.sql) does once the
-- connection-handling refactor (46 route files) is complete and
-- tested. This file alone changes NO runtime behavior at all.
--
-- ARCHITECTURAL FINDING, flagged explicitly: this does NOT reuse
-- src/db/platform/platform_core.sql's `companies` table. That
-- table's own header comment states it runs against a physically
-- SEPARATE control-plane database, by design, for a per-company-
-- database deployment model -- a foreign key from THIS database's
-- tables to a table in a different physical database is not just
-- inadvisable, it's impossible in Postgres. This creates a new,
-- deliberately minimal `tenants` table IN THIS SAME database,
-- sized for the actual near-term need (a handful of pilot
-- companies sharing one deployment via RLS) rather than the
-- original per-database platform vision. If per-database
-- multi-tenancy is ever actually built, reconciling these two
-- registries is a real, separate design question -- not
-- something this migration silently resolves by picking one.
-- ============================================================

create table if not exists tenants (
  id          bigserial primary key,
  tenant_code text        not null unique,
  tenant_name text        not null,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- Every table below already holds exactly one (unlabeled) tenant's
-- data today -- this row represents that existing data, so nothing
-- currently in the database loses visibility once tenant_id
-- becomes NOT NULL below. Real pilot companies get their own real
-- row inserted separately (application-level onboarding, not this
-- migration's job) -- this one exists solely to backfill history.
insert into tenants (tenant_code, tenant_name)
values ('DEFAULT', 'Default (pre-multi-tenancy data)')
on conflict (tenant_code) do nothing;

-- ---- approval_hierarchies ----
alter table approval_hierarchies add column if not exists tenant_id bigint references tenants(id);
update approval_hierarchies set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table approval_hierarchies alter column tenant_id set not null;
create index if not exists idx_approval_hierarchies_tenant on approval_hierarchies(tenant_id);
alter table approval_hierarchies enable row level security;
drop policy if exists tenant_isolation on approval_hierarchies;
create policy tenant_isolation on approval_hierarchies
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- approval_hierarchy_levels ----
alter table approval_hierarchy_levels add column if not exists tenant_id bigint references tenants(id);
update approval_hierarchy_levels set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table approval_hierarchy_levels alter column tenant_id set not null;
create index if not exists idx_approval_hierarchy_levels_tenant on approval_hierarchy_levels(tenant_id);
alter table approval_hierarchy_levels enable row level security;
drop policy if exists tenant_isolation on approval_hierarchy_levels;
create policy tenant_isolation on approval_hierarchy_levels
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- attendance_correction_requests ----
alter table attendance_correction_requests add column if not exists tenant_id bigint references tenants(id);
update attendance_correction_requests set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table attendance_correction_requests alter column tenant_id set not null;
create index if not exists idx_attendance_correction_requests_tenant on attendance_correction_requests(tenant_id);
alter table attendance_correction_requests enable row level security;
drop policy if exists tenant_isolation on attendance_correction_requests;
create policy tenant_isolation on attendance_correction_requests
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- attendance_import_batches ----
alter table attendance_import_batches add column if not exists tenant_id bigint references tenants(id);
update attendance_import_batches set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table attendance_import_batches alter column tenant_id set not null;
create index if not exists idx_attendance_import_batches_tenant on attendance_import_batches(tenant_id);
alter table attendance_import_batches enable row level security;
drop policy if exists tenant_isolation on attendance_import_batches;
create policy tenant_isolation on attendance_import_batches
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- attendance_import_rows ----
alter table attendance_import_rows add column if not exists tenant_id bigint references tenants(id);
update attendance_import_rows set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table attendance_import_rows alter column tenant_id set not null;
create index if not exists idx_attendance_import_rows_tenant on attendance_import_rows(tenant_id);
alter table attendance_import_rows enable row level security;
drop policy if exists tenant_isolation on attendance_import_rows;
create policy tenant_isolation on attendance_import_rows
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- attendance_locks ----
alter table attendance_locks add column if not exists tenant_id bigint references tenants(id);
update attendance_locks set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table attendance_locks alter column tenant_id set not null;
create index if not exists idx_attendance_locks_tenant on attendance_locks(tenant_id);
alter table attendance_locks enable row level security;
drop policy if exists tenant_isolation on attendance_locks;
create policy tenant_isolation on attendance_locks
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- attendance_mapping_templates ----
alter table attendance_mapping_templates add column if not exists tenant_id bigint references tenants(id);
update attendance_mapping_templates set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table attendance_mapping_templates alter column tenant_id set not null;
create index if not exists idx_attendance_mapping_templates_tenant on attendance_mapping_templates(tenant_id);
alter table attendance_mapping_templates enable row level security;
drop policy if exists tenant_isolation on attendance_mapping_templates;
create policy tenant_isolation on attendance_mapping_templates
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- attendance_policies ----
alter table attendance_policies add column if not exists tenant_id bigint references tenants(id);
update attendance_policies set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table attendance_policies alter column tenant_id set not null;
create index if not exists idx_attendance_policies_tenant on attendance_policies(tenant_id);
alter table attendance_policies enable row level security;
drop policy if exists tenant_isolation on attendance_policies;
create policy tenant_isolation on attendance_policies
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- attendance_records ----
alter table attendance_records add column if not exists tenant_id bigint references tenants(id);
update attendance_records set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table attendance_records alter column tenant_id set not null;
create index if not exists idx_attendance_records_tenant on attendance_records(tenant_id);
alter table attendance_records enable row level security;
drop policy if exists tenant_isolation on attendance_records;
create policy tenant_isolation on attendance_records
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- attendance_statuses ----
alter table attendance_statuses add column if not exists tenant_id bigint references tenants(id);
update attendance_statuses set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table attendance_statuses alter column tenant_id set not null;
create index if not exists idx_attendance_statuses_tenant on attendance_statuses(tenant_id);
alter table attendance_statuses enable row level security;
drop policy if exists tenant_isolation on attendance_statuses;
create policy tenant_isolation on attendance_statuses
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- audit_log ----
alter table audit_log add column if not exists tenant_id bigint references tenants(id);
update audit_log set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table audit_log alter column tenant_id set not null;
create index if not exists idx_audit_log_tenant on audit_log(tenant_id);
alter table audit_log enable row level security;
drop policy if exists tenant_isolation on audit_log;
create policy tenant_isolation on audit_log
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- bank_accounts ----
alter table bank_accounts add column if not exists tenant_id bigint references tenants(id);
update bank_accounts set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table bank_accounts alter column tenant_id set not null;
create index if not exists idx_bank_accounts_tenant on bank_accounts(tenant_id);
alter table bank_accounts enable row level security;
drop policy if exists tenant_isolation on bank_accounts;
create policy tenant_isolation on bank_accounts
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- bank_import_batches ----
alter table bank_import_batches add column if not exists tenant_id bigint references tenants(id);
update bank_import_batches set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table bank_import_batches alter column tenant_id set not null;
create index if not exists idx_bank_import_batches_tenant on bank_import_batches(tenant_id);
alter table bank_import_batches enable row level security;
drop policy if exists tenant_isolation on bank_import_batches;
create policy tenant_isolation on bank_import_batches
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- bank_import_rows ----
alter table bank_import_rows add column if not exists tenant_id bigint references tenants(id);
update bank_import_rows set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table bank_import_rows alter column tenant_id set not null;
create index if not exists idx_bank_import_rows_tenant on bank_import_rows(tenant_id);
alter table bank_import_rows enable row level security;
drop policy if exists tenant_isolation on bank_import_rows;
create policy tenant_isolation on bank_import_rows
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- bank_transactions ----
alter table bank_transactions add column if not exists tenant_id bigint references tenants(id);
update bank_transactions set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table bank_transactions alter column tenant_id set not null;
create index if not exists idx_bank_transactions_tenant on bank_transactions(tenant_id);
alter table bank_transactions enable row level security;
drop policy if exists tenant_isolation on bank_transactions;
create policy tenant_isolation on bank_transactions
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- branches ----
alter table branches add column if not exists tenant_id bigint references tenants(id);
update branches set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table branches alter column tenant_id set not null;
create index if not exists idx_branches_tenant on branches(tenant_id);
alter table branches enable row level security;
drop policy if exists tenant_isolation on branches;
create policy tenant_isolation on branches
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- chart_of_accounts ----
alter table chart_of_accounts add column if not exists tenant_id bigint references tenants(id);
update chart_of_accounts set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table chart_of_accounts alter column tenant_id set not null;
create index if not exists idx_chart_of_accounts_tenant on chart_of_accounts(tenant_id);
alter table chart_of_accounts enable row level security;
drop policy if exists tenant_isolation on chart_of_accounts;
create policy tenant_isolation on chart_of_accounts
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- cost_centers ----
alter table cost_centers add column if not exists tenant_id bigint references tenants(id);
update cost_centers set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table cost_centers alter column tenant_id set not null;
create index if not exists idx_cost_centers_tenant on cost_centers(tenant_id);
alter table cost_centers enable row level security;
drop policy if exists tenant_isolation on cost_centers;
create policy tenant_isolation on cost_centers
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- costing_records ----
alter table costing_records add column if not exists tenant_id bigint references tenants(id);
update costing_records set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table costing_records alter column tenant_id set not null;
create index if not exists idx_costing_records_tenant on costing_records(tenant_id);
alter table costing_records enable row level security;
drop policy if exists tenant_isolation on costing_records;
create policy tenant_isolation on costing_records
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- credit_notes ----
alter table credit_notes add column if not exists tenant_id bigint references tenants(id);
update credit_notes set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table credit_notes alter column tenant_id set not null;
create index if not exists idx_credit_notes_tenant on credit_notes(tenant_id);
alter table credit_notes enable row level security;
drop policy if exists tenant_isolation on credit_notes;
create policy tenant_isolation on credit_notes
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- crm_activities ----
alter table crm_activities add column if not exists tenant_id bigint references tenants(id);
update crm_activities set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table crm_activities alter column tenant_id set not null;
create index if not exists idx_crm_activities_tenant on crm_activities(tenant_id);
alter table crm_activities enable row level security;
drop policy if exists tenant_isolation on crm_activities;
create policy tenant_isolation on crm_activities
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- crm_followups ----
alter table crm_followups add column if not exists tenant_id bigint references tenants(id);
update crm_followups set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table crm_followups alter column tenant_id set not null;
create index if not exists idx_crm_followups_tenant on crm_followups(tenant_id);
alter table crm_followups enable row level security;
drop policy if exists tenant_isolation on crm_followups;
create policy tenant_isolation on crm_followups
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- crm_leads ----
alter table crm_leads add column if not exists tenant_id bigint references tenants(id);
update crm_leads set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table crm_leads alter column tenant_id set not null;
create index if not exists idx_crm_leads_tenant on crm_leads(tenant_id);
alter table crm_leads enable row level security;
drop policy if exists tenant_isolation on crm_leads;
create policy tenant_isolation on crm_leads
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- customer_requests ----
alter table customer_requests add column if not exists tenant_id bigint references tenants(id);
update customer_requests set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table customer_requests alter column tenant_id set not null;
create index if not exists idx_customer_requests_tenant on customer_requests(tenant_id);
alter table customer_requests enable row level security;
drop policy if exists tenant_isolation on customer_requests;
create policy tenant_isolation on customer_requests
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- customers ----
alter table customers add column if not exists tenant_id bigint references tenants(id);
update customers set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table customers alter column tenant_id set not null;
create index if not exists idx_customers_tenant on customers(tenant_id);
alter table customers enable row level security;
drop policy if exists tenant_isolation on customers;
create policy tenant_isolation on customers
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- debit_notes ----
alter table debit_notes add column if not exists tenant_id bigint references tenants(id);
update debit_notes set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table debit_notes alter column tenant_id set not null;
create index if not exists idx_debit_notes_tenant on debit_notes(tenant_id);
alter table debit_notes enable row level security;
drop policy if exists tenant_isolation on debit_notes;
create policy tenant_isolation on debit_notes
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- departments ----
alter table departments add column if not exists tenant_id bigint references tenants(id);
update departments set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table departments alter column tenant_id set not null;
create index if not exists idx_departments_tenant on departments(tenant_id);
alter table departments enable row level security;
drop policy if exists tenant_isolation on departments;
create policy tenant_isolation on departments
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- designations ----
alter table designations add column if not exists tenant_id bigint references tenants(id);
update designations set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table designations alter column tenant_id set not null;
create index if not exists idx_designations_tenant on designations(tenant_id);
alter table designations enable row level security;
drop policy if exists tenant_isolation on designations;
create policy tenant_isolation on designations
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_addresses ----
alter table employee_addresses add column if not exists tenant_id bigint references tenants(id);
update employee_addresses set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_addresses alter column tenant_id set not null;
create index if not exists idx_employee_addresses_tenant on employee_addresses(tenant_id);
alter table employee_addresses enable row level security;
drop policy if exists tenant_isolation on employee_addresses;
create policy tenant_isolation on employee_addresses
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_assets ----
alter table employee_assets add column if not exists tenant_id bigint references tenants(id);
update employee_assets set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_assets alter column tenant_id set not null;
create index if not exists idx_employee_assets_tenant on employee_assets(tenant_id);
alter table employee_assets enable row level security;
drop policy if exists tenant_isolation on employee_assets;
create policy tenant_isolation on employee_assets
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_bank_details ----
alter table employee_bank_details add column if not exists tenant_id bigint references tenants(id);
update employee_bank_details set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_bank_details alter column tenant_id set not null;
create index if not exists idx_employee_bank_details_tenant on employee_bank_details(tenant_id);
alter table employee_bank_details enable row level security;
drop policy if exists tenant_isolation on employee_bank_details;
create policy tenant_isolation on employee_bank_details
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_certifications ----
alter table employee_certifications add column if not exists tenant_id bigint references tenants(id);
update employee_certifications set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_certifications alter column tenant_id set not null;
create index if not exists idx_employee_certifications_tenant on employee_certifications(tenant_id);
alter table employee_certifications enable row level security;
drop policy if exists tenant_isolation on employee_certifications;
create policy tenant_isolation on employee_certifications
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_contact_details ----
alter table employee_contact_details add column if not exists tenant_id bigint references tenants(id);
update employee_contact_details set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_contact_details alter column tenant_id set not null;
create index if not exists idx_employee_contact_details_tenant on employee_contact_details(tenant_id);
alter table employee_contact_details enable row level security;
drop policy if exists tenant_isolation on employee_contact_details;
create policy tenant_isolation on employee_contact_details
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_documents ----
alter table employee_documents add column if not exists tenant_id bigint references tenants(id);
update employee_documents set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_documents alter column tenant_id set not null;
create index if not exists idx_employee_documents_tenant on employee_documents(tenant_id);
alter table employee_documents enable row level security;
drop policy if exists tenant_isolation on employee_documents;
create policy tenant_isolation on employee_documents
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_education ----
alter table employee_education add column if not exists tenant_id bigint references tenants(id);
update employee_education set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_education alter column tenant_id set not null;
create index if not exists idx_employee_education_tenant on employee_education(tenant_id);
alter table employee_education enable row level security;
drop policy if exists tenant_isolation on employee_education;
create policy tenant_isolation on employee_education
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_emergency_contacts ----
alter table employee_emergency_contacts add column if not exists tenant_id bigint references tenants(id);
update employee_emergency_contacts set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_emergency_contacts alter column tenant_id set not null;
create index if not exists idx_employee_emergency_contacts_tenant on employee_emergency_contacts(tenant_id);
alter table employee_emergency_contacts enable row level security;
drop policy if exists tenant_isolation on employee_emergency_contacts;
create policy tenant_isolation on employee_emergency_contacts
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_experience ----
alter table employee_experience add column if not exists tenant_id bigint references tenants(id);
update employee_experience set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_experience alter column tenant_id set not null;
create index if not exists idx_employee_experience_tenant on employee_experience(tenant_id);
alter table employee_experience enable row level security;
drop policy if exists tenant_isolation on employee_experience;
create policy tenant_isolation on employee_experience
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_loans ----
alter table employee_loans add column if not exists tenant_id bigint references tenants(id);
update employee_loans set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_loans alter column tenant_id set not null;
create index if not exists idx_employee_loans_tenant on employee_loans(tenant_id);
alter table employee_loans enable row level security;
drop policy if exists tenant_isolation on employee_loans;
create policy tenant_isolation on employee_loans
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_master ----
alter table employee_master add column if not exists tenant_id bigint references tenants(id);
update employee_master set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_master alter column tenant_id set not null;
create index if not exists idx_employee_master_tenant on employee_master(tenant_id);
alter table employee_master enable row level security;
drop policy if exists tenant_isolation on employee_master;
create policy tenant_isolation on employee_master
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_salary_structure_assignments ----
alter table employee_salary_structure_assignments add column if not exists tenant_id bigint references tenants(id);
update employee_salary_structure_assignments set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_salary_structure_assignments alter column tenant_id set not null;
create index if not exists idx_employee_salary_structure_assignments_tenant on employee_salary_structure_assignments(tenant_id);
alter table employee_salary_structure_assignments enable row level security;
drop policy if exists tenant_isolation on employee_salary_structure_assignments;
create policy tenant_isolation on employee_salary_structure_assignments
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_shift_assignments ----
alter table employee_shift_assignments add column if not exists tenant_id bigint references tenants(id);
update employee_shift_assignments set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_shift_assignments alter column tenant_id set not null;
create index if not exists idx_employee_shift_assignments_tenant on employee_shift_assignments(tenant_id);
alter table employee_shift_assignments enable row level security;
drop policy if exists tenant_isolation on employee_shift_assignments;
create policy tenant_isolation on employee_shift_assignments
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_skills ----
alter table employee_skills add column if not exists tenant_id bigint references tenants(id);
update employee_skills set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_skills alter column tenant_id set not null;
create index if not exists idx_employee_skills_tenant on employee_skills(tenant_id);
alter table employee_skills enable row level security;
drop policy if exists tenant_isolation on employee_skills;
create policy tenant_isolation on employee_skills
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employee_statutory_details ----
alter table employee_statutory_details add column if not exists tenant_id bigint references tenants(id);
update employee_statutory_details set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employee_statutory_details alter column tenant_id set not null;
create index if not exists idx_employee_statutory_details_tenant on employee_statutory_details(tenant_id);
alter table employee_statutory_details enable row level security;
drop policy if exists tenant_isolation on employee_statutory_details;
create policy tenant_isolation on employee_statutory_details
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employees ----
alter table employees add column if not exists tenant_id bigint references tenants(id);
update employees set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employees alter column tenant_id set not null;
create index if not exists idx_employees_tenant on employees(tenant_id);
alter table employees enable row level security;
drop policy if exists tenant_isolation on employees;
create policy tenant_isolation on employees
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- employment_types ----
alter table employment_types add column if not exists tenant_id bigint references tenants(id);
update employment_types set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table employment_types alter column tenant_id set not null;
create index if not exists idx_employment_types_tenant on employment_types(tenant_id);
alter table employment_types enable row level security;
drop policy if exists tenant_isolation on employment_types;
create policy tenant_isolation on employment_types
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- financial_years ----
alter table financial_years add column if not exists tenant_id bigint references tenants(id);
update financial_years set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table financial_years alter column tenant_id set not null;
create index if not exists idx_financial_years_tenant on financial_years(tenant_id);
alter table financial_years enable row level security;
drop policy if exists tenant_isolation on financial_years;
create policy tenant_isolation on financial_years
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- holidays ----
alter table holidays add column if not exists tenant_id bigint references tenants(id);
update holidays set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table holidays alter column tenant_id set not null;
create index if not exists idx_holidays_tenant on holidays(tenant_id);
alter table holidays enable row level security;
drop policy if exists tenant_isolation on holidays;
create policy tenant_isolation on holidays
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- inventory ----
alter table inventory add column if not exists tenant_id bigint references tenants(id);
update inventory set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table inventory alter column tenant_id set not null;
create index if not exists idx_inventory_tenant on inventory(tenant_id);
alter table inventory enable row level security;
drop policy if exists tenant_isolation on inventory;
create policy tenant_isolation on inventory
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- inventory_transactions ----
alter table inventory_transactions add column if not exists tenant_id bigint references tenants(id);
update inventory_transactions set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table inventory_transactions alter column tenant_id set not null;
create index if not exists idx_inventory_transactions_tenant on inventory_transactions(tenant_id);
alter table inventory_transactions enable row level security;
drop policy if exists tenant_isolation on inventory_transactions;
create policy tenant_isolation on inventory_transactions
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- journal_entries ----
alter table journal_entries add column if not exists tenant_id bigint references tenants(id);
update journal_entries set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table journal_entries alter column tenant_id set not null;
create index if not exists idx_journal_entries_tenant on journal_entries(tenant_id);
alter table journal_entries enable row level security;
drop policy if exists tenant_isolation on journal_entries;
create policy tenant_isolation on journal_entries
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- journal_entry_lines ----
alter table journal_entry_lines add column if not exists tenant_id bigint references tenants(id);
update journal_entry_lines set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table journal_entry_lines alter column tenant_id set not null;
create index if not exists idx_journal_entry_lines_tenant on journal_entry_lines(tenant_id);
alter table journal_entry_lines enable row level security;
drop policy if exists tenant_isolation on journal_entry_lines;
create policy tenant_isolation on journal_entry_lines
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- leave_balance_transactions ----
alter table leave_balance_transactions add column if not exists tenant_id bigint references tenants(id);
update leave_balance_transactions set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table leave_balance_transactions alter column tenant_id set not null;
create index if not exists idx_leave_balance_transactions_tenant on leave_balance_transactions(tenant_id);
alter table leave_balance_transactions enable row level security;
drop policy if exists tenant_isolation on leave_balance_transactions;
create policy tenant_isolation on leave_balance_transactions
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- leave_policies ----
alter table leave_policies add column if not exists tenant_id bigint references tenants(id);
update leave_policies set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table leave_policies alter column tenant_id set not null;
create index if not exists idx_leave_policies_tenant on leave_policies(tenant_id);
alter table leave_policies enable row level security;
drop policy if exists tenant_isolation on leave_policies;
create policy tenant_isolation on leave_policies
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- leave_requests ----
alter table leave_requests add column if not exists tenant_id bigint references tenants(id);
update leave_requests set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table leave_requests alter column tenant_id set not null;
create index if not exists idx_leave_requests_tenant on leave_requests(tenant_id);
alter table leave_requests enable row level security;
drop policy if exists tenant_isolation on leave_requests;
create policy tenant_isolation on leave_requests
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- leave_types ----
alter table leave_types add column if not exists tenant_id bigint references tenants(id);
update leave_types set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table leave_types alter column tenant_id set not null;
create index if not exists idx_leave_types_tenant on leave_types(tenant_id);
alter table leave_types enable row level security;
drop policy if exists tenant_isolation on leave_types;
create policy tenant_isolation on leave_types
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- leave_year_configurations ----
alter table leave_year_configurations add column if not exists tenant_id bigint references tenants(id);
update leave_year_configurations set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table leave_year_configurations alter column tenant_id set not null;
create index if not exists idx_leave_year_configurations_tenant on leave_year_configurations(tenant_id);
alter table leave_year_configurations enable row level security;
drop policy if exists tenant_isolation on leave_year_configurations;
create policy tenant_isolation on leave_year_configurations
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- loan_installments ----
alter table loan_installments add column if not exists tenant_id bigint references tenants(id);
update loan_installments set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table loan_installments alter column tenant_id set not null;
create index if not exists idx_loan_installments_tenant on loan_installments(tenant_id);
alter table loan_installments enable row level security;
drop policy if exists tenant_isolation on loan_installments;
create policy tenant_isolation on loan_installments
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- mapping_templates ----
alter table mapping_templates add column if not exists tenant_id bigint references tenants(id);
update mapping_templates set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table mapping_templates alter column tenant_id set not null;
create index if not exists idx_mapping_templates_tenant on mapping_templates(tenant_id);
alter table mapping_templates enable row level security;
drop policy if exists tenant_isolation on mapping_templates;
create policy tenant_isolation on mapping_templates
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- numbering_sequences ----
alter table numbering_sequences add column if not exists tenant_id bigint references tenants(id);
update numbering_sequences set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table numbering_sequences alter column tenant_id set not null;
create index if not exists idx_numbering_sequences_tenant on numbering_sequences(tenant_id);
alter table numbering_sequences enable row level security;
drop policy if exists tenant_isolation on numbering_sequences;
create policy tenant_isolation on numbering_sequences
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- payment_allocations ----
alter table payment_allocations add column if not exists tenant_id bigint references tenants(id);
update payment_allocations set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table payment_allocations alter column tenant_id set not null;
create index if not exists idx_payment_allocations_tenant on payment_allocations(tenant_id);
alter table payment_allocations enable row level security;
drop policy if exists tenant_isolation on payment_allocations;
create policy tenant_isolation on payment_allocations
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- payments ----
alter table payments add column if not exists tenant_id bigint references tenants(id);
update payments set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table payments alter column tenant_id set not null;
create index if not exists idx_payments_tenant on payments(tenant_id);
alter table payments enable row level security;
drop policy if exists tenant_isolation on payments;
create policy tenant_isolation on payments
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- payroll_account_mappings ----
alter table payroll_account_mappings add column if not exists tenant_id bigint references tenants(id);
update payroll_account_mappings set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table payroll_account_mappings alter column tenant_id set not null;
create index if not exists idx_payroll_account_mappings_tenant on payroll_account_mappings(tenant_id);
alter table payroll_account_mappings enable row level security;
drop policy if exists tenant_isolation on payroll_account_mappings;
create policy tenant_isolation on payroll_account_mappings
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- payroll_line_components ----
alter table payroll_line_components add column if not exists tenant_id bigint references tenants(id);
update payroll_line_components set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table payroll_line_components alter column tenant_id set not null;
create index if not exists idx_payroll_line_components_tenant on payroll_line_components(tenant_id);
alter table payroll_line_components enable row level security;
drop policy if exists tenant_isolation on payroll_line_components;
create policy tenant_isolation on payroll_line_components
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- payroll_lines ----
alter table payroll_lines add column if not exists tenant_id bigint references tenants(id);
update payroll_lines set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table payroll_lines alter column tenant_id set not null;
create index if not exists idx_payroll_lines_tenant on payroll_lines(tenant_id);
alter table payroll_lines enable row level security;
drop policy if exists tenant_isolation on payroll_lines;
create policy tenant_isolation on payroll_lines
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- payroll_runs ----
alter table payroll_runs add column if not exists tenant_id bigint references tenants(id);
update payroll_runs set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table payroll_runs alter column tenant_id set not null;
create index if not exists idx_payroll_runs_tenant on payroll_runs(tenant_id);
alter table payroll_runs enable row level security;
drop policy if exists tenant_isolation on payroll_runs;
create policy tenant_isolation on payroll_runs
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- portal_config ----
alter table portal_config add column if not exists tenant_id bigint references tenants(id);
update portal_config set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table portal_config alter column tenant_id set not null;
create index if not exists idx_portal_config_tenant on portal_config(tenant_id);
alter table portal_config enable row level security;
drop policy if exists tenant_isolation on portal_config;
create policy tenant_isolation on portal_config
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_activity_log ----
alter table project_activity_log add column if not exists tenant_id bigint references tenants(id);
update project_activity_log set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_activity_log alter column tenant_id set not null;
create index if not exists idx_project_activity_log_tenant on project_activity_log(tenant_id);
alter table project_activity_log enable row level security;
drop policy if exists tenant_isolation on project_activity_log;
create policy tenant_isolation on project_activity_log
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_budget ----
alter table project_budget add column if not exists tenant_id bigint references tenants(id);
update project_budget set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_budget alter column tenant_id set not null;
create index if not exists idx_project_budget_tenant on project_budget(tenant_id);
alter table project_budget enable row level security;
drop policy if exists tenant_isolation on project_budget;
create policy tenant_isolation on project_budget
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_budget_versions ----
alter table project_budget_versions add column if not exists tenant_id bigint references tenants(id);
update project_budget_versions set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_budget_versions alter column tenant_id set not null;
create index if not exists idx_project_budget_versions_tenant on project_budget_versions(tenant_id);
alter table project_budget_versions enable row level security;
drop policy if exists tenant_isolation on project_budget_versions;
create policy tenant_isolation on project_budget_versions
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_categories ----
alter table project_categories add column if not exists tenant_id bigint references tenants(id);
update project_categories set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_categories alter column tenant_id set not null;
create index if not exists idx_project_categories_tenant on project_categories(tenant_id);
alter table project_categories enable row level security;
drop policy if exists tenant_isolation on project_categories;
create policy tenant_isolation on project_categories
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_documents ----
alter table project_documents add column if not exists tenant_id bigint references tenants(id);
update project_documents set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_documents alter column tenant_id set not null;
create index if not exists idx_project_documents_tenant on project_documents(tenant_id);
alter table project_documents enable row level security;
drop policy if exists tenant_isolation on project_documents;
create policy tenant_isolation on project_documents
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_estimates ----
alter table project_estimates add column if not exists tenant_id bigint references tenants(id);
update project_estimates set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_estimates alter column tenant_id set not null;
create index if not exists idx_project_estimates_tenant on project_estimates(tenant_id);
alter table project_estimates enable row level security;
drop policy if exists tenant_isolation on project_estimates;
create policy tenant_isolation on project_estimates
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_members ----
alter table project_members add column if not exists tenant_id bigint references tenants(id);
update project_members set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_members alter column tenant_id set not null;
create index if not exists idx_project_members_tenant on project_members(tenant_id);
alter table project_members enable row level security;
drop policy if exists tenant_isolation on project_members;
create policy tenant_isolation on project_members
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_milestones ----
alter table project_milestones add column if not exists tenant_id bigint references tenants(id);
update project_milestones set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_milestones alter column tenant_id set not null;
create index if not exists idx_project_milestones_tenant on project_milestones(tenant_id);
alter table project_milestones enable row level security;
drop policy if exists tenant_isolation on project_milestones;
create policy tenant_isolation on project_milestones
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_notes ----
alter table project_notes add column if not exists tenant_id bigint references tenants(id);
update project_notes set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_notes alter column tenant_id set not null;
create index if not exists idx_project_notes_tenant on project_notes(tenant_id);
alter table project_notes enable row level security;
drop policy if exists tenant_isolation on project_notes;
create policy tenant_isolation on project_notes
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- project_tasks ----
alter table project_tasks add column if not exists tenant_id bigint references tenants(id);
update project_tasks set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table project_tasks alter column tenant_id set not null;
create index if not exists idx_project_tasks_tenant on project_tasks(tenant_id);
alter table project_tasks enable row level security;
drop policy if exists tenant_isolation on project_tasks;
create policy tenant_isolation on project_tasks
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- projects ----
alter table projects add column if not exists tenant_id bigint references tenants(id);
update projects set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table projects alter column tenant_id set not null;
create index if not exists idx_projects_tenant on projects(tenant_id);
alter table projects enable row level security;
drop policy if exists tenant_isolation on projects;
create policy tenant_isolation on projects
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- purchase_invoice_lines ----
alter table purchase_invoice_lines add column if not exists tenant_id bigint references tenants(id);
update purchase_invoice_lines set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table purchase_invoice_lines alter column tenant_id set not null;
create index if not exists idx_purchase_invoice_lines_tenant on purchase_invoice_lines(tenant_id);
alter table purchase_invoice_lines enable row level security;
drop policy if exists tenant_isolation on purchase_invoice_lines;
create policy tenant_isolation on purchase_invoice_lines
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- purchase_invoices ----
alter table purchase_invoices add column if not exists tenant_id bigint references tenants(id);
update purchase_invoices set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table purchase_invoices alter column tenant_id set not null;
create index if not exists idx_purchase_invoices_tenant on purchase_invoices(tenant_id);
alter table purchase_invoices enable row level security;
drop policy if exists tenant_isolation on purchase_invoices;
create policy tenant_isolation on purchase_invoices
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- receipt_allocations ----
alter table receipt_allocations add column if not exists tenant_id bigint references tenants(id);
update receipt_allocations set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table receipt_allocations alter column tenant_id set not null;
create index if not exists idx_receipt_allocations_tenant on receipt_allocations(tenant_id);
alter table receipt_allocations enable row level security;
drop policy if exists tenant_isolation on receipt_allocations;
create policy tenant_isolation on receipt_allocations
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- receipts ----
alter table receipts add column if not exists tenant_id bigint references tenants(id);
update receipts set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table receipts alter column tenant_id set not null;
create index if not exists idx_receipts_tenant on receipts(tenant_id);
alter table receipts enable row level security;
drop policy if exists tenant_isolation on receipts;
create policy tenant_isolation on receipts
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- reimbursement_claims ----
alter table reimbursement_claims add column if not exists tenant_id bigint references tenants(id);
update reimbursement_claims set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table reimbursement_claims alter column tenant_id set not null;
create index if not exists idx_reimbursement_claims_tenant on reimbursement_claims(tenant_id);
alter table reimbursement_claims enable row level security;
drop policy if exists tenant_isolation on reimbursement_claims;
create policy tenant_isolation on reimbursement_claims
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- salary_components ----
alter table salary_components add column if not exists tenant_id bigint references tenants(id);
update salary_components set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table salary_components alter column tenant_id set not null;
create index if not exists idx_salary_components_tenant on salary_components(tenant_id);
alter table salary_components enable row level security;
drop policy if exists tenant_isolation on salary_components;
create policy tenant_isolation on salary_components
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- salary_structure_components ----
alter table salary_structure_components add column if not exists tenant_id bigint references tenants(id);
update salary_structure_components set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table salary_structure_components alter column tenant_id set not null;
create index if not exists idx_salary_structure_components_tenant on salary_structure_components(tenant_id);
alter table salary_structure_components enable row level security;
drop policy if exists tenant_isolation on salary_structure_components;
create policy tenant_isolation on salary_structure_components
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- salary_structures ----
alter table salary_structures add column if not exists tenant_id bigint references tenants(id);
update salary_structures set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table salary_structures alter column tenant_id set not null;
create index if not exists idx_salary_structures_tenant on salary_structures(tenant_id);
alter table salary_structures enable row level security;
drop policy if exists tenant_isolation on salary_structures;
create policy tenant_isolation on salary_structures
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- sales_invoice_lines ----
alter table sales_invoice_lines add column if not exists tenant_id bigint references tenants(id);
update sales_invoice_lines set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table sales_invoice_lines alter column tenant_id set not null;
create index if not exists idx_sales_invoice_lines_tenant on sales_invoice_lines(tenant_id);
alter table sales_invoice_lines enable row level security;
drop policy if exists tenant_isolation on sales_invoice_lines;
create policy tenant_isolation on sales_invoice_lines
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- sales_invoices ----
alter table sales_invoices add column if not exists tenant_id bigint references tenants(id);
update sales_invoices set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table sales_invoices alter column tenant_id set not null;
create index if not exists idx_sales_invoices_tenant on sales_invoices(tenant_id);
alter table sales_invoices enable row level security;
drop policy if exists tenant_isolation on sales_invoices;
create policy tenant_isolation on sales_invoices
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- shift_overrides ----
alter table shift_overrides add column if not exists tenant_id bigint references tenants(id);
update shift_overrides set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table shift_overrides alter column tenant_id set not null;
create index if not exists idx_shift_overrides_tenant on shift_overrides(tenant_id);
alter table shift_overrides enable row level security;
drop policy if exists tenant_isolation on shift_overrides;
create policy tenant_isolation on shift_overrides
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- shifts ----
alter table shifts add column if not exists tenant_id bigint references tenants(id);
update shifts set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table shifts alter column tenant_id set not null;
create index if not exists idx_shifts_tenant on shifts(tenant_id);
alter table shifts enable row level security;
drop policy if exists tenant_isolation on shifts;
create policy tenant_isolation on shifts
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- tds_deductions ----
alter table tds_deductions add column if not exists tenant_id bigint references tenants(id);
update tds_deductions set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table tds_deductions alter column tenant_id set not null;
create index if not exists idx_tds_deductions_tenant on tds_deductions(tenant_id);
alter table tds_deductions enable row level security;
drop policy if exists tenant_isolation on tds_deductions;
create policy tenant_isolation on tds_deductions
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- user_roles ----
alter table user_roles add column if not exists tenant_id bigint references tenants(id);
update user_roles set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table user_roles alter column tenant_id set not null;
create index if not exists idx_user_roles_tenant on user_roles(tenant_id);
alter table user_roles enable row level security;
drop policy if exists tenant_isolation on user_roles;
create policy tenant_isolation on user_roles
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- vendors ----
alter table vendors add column if not exists tenant_id bigint references tenants(id);
update vendors set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table vendors alter column tenant_id set not null;
create index if not exists idx_vendors_tenant on vendors(tenant_id);
alter table vendors enable row level security;
drop policy if exists tenant_isolation on vendors;
create policy tenant_isolation on vendors
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- ---- weekly_off_configurations ----
alter table weekly_off_configurations add column if not exists tenant_id bigint references tenants(id);
update weekly_off_configurations set tenant_id = (select id from tenants where tenant_code = 'DEFAULT') where tenant_id is null;
alter table weekly_off_configurations alter column tenant_id set not null;
create index if not exists idx_weekly_off_configurations_tenant on weekly_off_configurations(tenant_id);
alter table weekly_off_configurations enable row level security;
drop policy if exists tenant_isolation on weekly_off_configurations;
create policy tenant_isolation on weekly_off_configurations
  using (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- FIX: numbering_sequences' existing unique(document_type,
-- financial_year_id) constraint must widen to include tenant_id --
-- without this, two DIFFERENT tenants could never both have (say)
-- a 'sales_invoice' sequence for financial_year_id values that
-- happen to collide, and more subtly, the ON CONFLICT clause in
-- number-generator.ts's nextDocumentNumber() targets this exact
-- constraint by name/columns -- leaving it unwidened would make
-- that bootstrap logic silently target the wrong uniqueness rule.
alter table numbering_sequences drop constraint if exists numbering_sequences_document_type_financial_year_id_key;
alter table numbering_sequences add constraint numbering_sequences_tenant_doctype_fy_key
  unique (tenant_id, document_type, financial_year_id);

-- ============================================================
-- FLAGGED, NOT DECIDED -- explicit design questions, not guesses:
--
-- 1. roles, permissions, role_permissions: left OUT of this
--    migration entirely. Same reasoning as tds_sections (shared
--    rate/reference master data) could argue these are shared
--    platform-wide role DEFINITIONS -- but a real tenant might
--    reasonably want to define its own custom roles independent
--    of other tenants, which would need them tenant-scoped
--    instead. user_roles (which EMPLOYEE has which role) IS
--    included above as tenant-scoped either way, since an
--    employee assignment is unambiguously tenant data regardless
--    of how the roles/permissions question is answered.
--
-- 2. document_types: left OUT. Unlike tds_sections/statutory_
--    rules (genuine government rate data), this is an HR master
--    table alongside departments/designations/branches -- all of
--    which ARE tenant-scoped above, since each company defines
--    its own org structure. document_types could go either way:
--    a fixed universal checklist, or something each company
--    customizes. Needs an explicit answer, not an assumption.
--
-- 3. statutory_rules, statutory_rule_slabs: left OUT, on my OWN
--    inference (same reasoning as tds_sections: real PF/ESI rate
--    master data, not business data) -- not something you
--    explicitly confirmed the way you did for tds_sections.
--    Flagging this so it gets a real yes/no, not silent agreement.
-- ============================================================