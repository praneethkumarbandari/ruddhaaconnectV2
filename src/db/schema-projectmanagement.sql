-- ------------------------------------------------------------
-- Ruddhaa Project Management — Phase 3 schema
--
-- Implements exactly the frozen Phase 2 architecture. Two parts:
--
--   PART A: new Project Management tables. None of these store a
--   computed financial total — budget/estimates are targets, never
--   actuals; actuals are always derived from Accounting's existing
--   tables at report time (see the future project-reports.ts).
--
--   PART B: additive, nullable project_id columns on the eight
--   existing transaction-bearing tables identified in Phase 2's
--   review. Every addition is NULLable with no default tied to
--   existing data, so no existing row, query, insert, or regression
--   test changes behavior. Confirmed empirically below, not assumed.
-- ------------------------------------------------------------

-- ==============================================================
-- PART A: Project Management's own tables
-- ==============================================================

create table project_categories (
  id          bigserial primary key,
  name        text        not null unique,
  description text,
  created_at  timestamptz not null default now()
);

create table projects (
  id           bigserial primary key,
  project_code text        not null unique,
  project_name text        not null,
  category_id  bigint      references project_categories(id),
  customer_id  bigint      references customers(id),
  status       text        not null default 'draft'
                 check (status in ('draft','active','on_hold','closing','closed')),
  start_date   date,
  target_end_date date,
  actual_end_date  date,
  created_by   bigint      references employees(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_projects_status on projects(status);
create index idx_projects_category on projects(category_id);
create index idx_projects_customer on projects(customer_id);

create table project_members (
  id          bigserial primary key,
  project_id  bigint      not null references projects(id),
  employee_id bigint      not null references employees(id),
  role        text        not null default 'member'
                check (role in ('manager','member','viewer')),
  added_at    timestamptz not null default now(),
  unique (project_id, employee_id)
);
create index idx_project_members_project on project_members(project_id);
create index idx_project_members_employee on project_members(employee_id);

create table project_documents (
  id           bigserial primary key,
  project_id   bigint      not null references projects(id),
  file_name    text        not null,
  storage_path text        not null,  -- external storage reference; no file blob stored here
  uploaded_by  bigint      references employees(id),
  uploaded_at  timestamptz not null default now()
);
create index idx_project_documents_project on project_documents(project_id);

create table project_notes (
  id         bigserial primary key,
  project_id bigint      not null references projects(id),
  author_id  bigint      references employees(id),
  note       text        not null,
  created_at timestamptz not null default now()
  -- append-only by convention: no update/delete route will be built for this table
);
create index idx_project_notes_project on project_notes(project_id);

create table project_milestones (
  id           bigserial primary key,
  project_id   bigint      not null references projects(id),
  milestone_name text      not null,
  target_date  date,
  actual_date  date,
  status       text        not null default 'pending'
                 check (status in ('pending','in_progress','done','skipped')),
  created_at   timestamptz not null default now()
);
create index idx_project_milestones_project on project_milestones(project_id);

create table project_tasks (
  id           bigserial primary key,
  project_id   bigint      not null references projects(id),
  milestone_id bigint      references project_milestones(id),
  task_name    text        not null,
  assignee_id  bigint      references employees(id),
  due_date     date,
  status       text        not null default 'pending'
                 check (status in ('pending','in_progress','done','cancelled')),
  created_at   timestamptz not null default now()
);
create index idx_project_tasks_project on project_tasks(project_id);
create index idx_project_tasks_milestone on project_tasks(milestone_id);

create table project_budget_versions (
  id          bigserial primary key,
  project_id  bigint      not null references projects(id),
  version_no  int         not null,
  status      text        not null default 'draft'
                check (status in ('draft','approved','superseded')),
  approved_by bigint      references employees(id),
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (project_id, version_no)
);
create index idx_project_budget_versions_project on project_budget_versions(project_id);
-- Enforced at the application layer (mirrors how only one financial year
-- is "open" at a time): only one version per project may be 'approved'.

create table project_budget (
  id               bigserial primary key,
  budget_version_id bigint    not null references project_budget_versions(id),
  account_code     text        references chart_of_accounts(account_code),  -- nullable, read-only reference; never joined into any posting path
  category_label   text,       -- used when no precise account mapping exists yet
  budget_type      text        not null check (budget_type in ('cost','revenue')),
  budgeted_amount  numeric(18,2) not null check (budgeted_amount >= 0),
  created_at       timestamptz not null default now()
);
create index idx_project_budget_version on project_budget(budget_version_id);

create table project_estimates (
  id              bigserial primary key,
  project_id      bigint      not null references projects(id),
  account_code    text        references chart_of_accounts(account_code),
  description     text        not null,
  estimated_qty   numeric(18,2),
  estimated_rate  numeric(18,2),
  estimated_amount numeric(18,2) not null check (estimated_amount >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index idx_project_estimates_project on project_estimates(project_id);

create table project_activity_log (
  id           bigserial primary key,
  project_id   bigint      not null references projects(id),
  performed_by bigint      references employees(id),
  action       text        not null,
  detail       jsonb,
  performed_at timestamptz not null default now()
  -- append-only, deliberately separate from accounting's own audit_log
);
create index idx_project_activity_log_project on project_activity_log(project_id);

-- ==============================================================
-- PART B: additive project_id tagging on existing accounting tables
--
-- Every column below is NULLABLE with no default — existing rows are
-- entirely unaffected, and no existing query changes behavior since
-- none of them select or filter on project_id today.
-- ==============================================================

alter table journal_entries    add column project_id bigint references projects(id);
alter table sales_invoices     add column project_id bigint references projects(id);
alter table purchase_invoices  add column project_id bigint references projects(id);
alter table receipts           add column project_id bigint references projects(id);
alter table payments           add column project_id bigint references projects(id);
alter table credit_notes       add column project_id bigint references projects(id);
alter table debit_notes        add column project_id bigint references projects(id);
alter table bank_import_rows   add column project_id bigint references projects(id);

create index idx_journal_entries_project on journal_entries(project_id);
create index idx_sales_invoices_project on sales_invoices(project_id);
create index idx_purchase_invoices_project on purchase_invoices(project_id);
create index idx_receipts_project on receipts(project_id);
create index idx_payments_project on payments(project_id);
create index idx_credit_notes_project on credit_notes(project_id);
create index idx_debit_notes_project on debit_notes(project_id);
create index idx_bank_import_rows_project on bank_import_rows(project_id);
