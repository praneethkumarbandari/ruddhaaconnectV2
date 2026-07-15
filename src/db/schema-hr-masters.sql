-- ============================================================
-- RUDDHAA ERP — HR MODULE, MILESTONE 1: MASTER DATA
--
-- Additive only. Depends on schema-permissions.sql having run
-- first (permission rows seeded below reference it) and on the
-- existing employees(id) table from schema.sql.
--
-- SCOPE NOTE — read before assuming this includes the Employee
-- Master: it does not. The full "Employee Management" section of
-- the HR spec (personal details, bank details, statutory details,
-- emergency contacts, qualifications, experience, documents,
-- assets, reporting manager / org hierarchy) is Milestone 2, kept
-- separate deliberately because of a real conflict discovered in
-- this codebase: `employees` (schema.sql) is already a live table
-- used for authentication (username/password_hash/login) AND is
-- already an FK target from schema-projectmanagement.sql
-- (created_by, assignee_id) and from schema-permissions.sql
-- (user_roles.employee_id). It cannot be dropped or renamed.
-- Milestone 2's Employee Master will be a 1:1 profile extension
-- keyed on employees.id (e.g. employee_profiles, employee_bank_details,
-- ... all with employee_id bigint primary key references employees(id)),
-- not a replacement of the identity table. This file only builds the
-- lookup/configuration masters that Milestone 2 and Payroll will
-- reference by FK, so that decision doesn't block this milestone.
--
-- Convention match with the existing codebase (chart_of_accounts,
-- customers, vendors): never hard-deleted, only deactivated via
-- is_active; a <resource>_code + <resource>_name pair; created_at/
-- updated_at timestamps; unique constraint on the code column.
-- ============================================================

-- ------------------------------------------------------------
-- DEPARTMENTS — self-referencing for org hierarchy (matches the
-- Project Management precedent of a plain nullable FK for the one
-- real hierarchy dimension that exists, not a generic tree framework).
-- ------------------------------------------------------------
create table departments (
  id                   bigserial primary key,
  department_code      text        not null unique,
  department_name      text        not null,
  parent_department_id bigint      references departments(id),
  is_active            boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index idx_departments_parent on departments(parent_department_id);
create index idx_departments_active on departments(is_active);

-- ------------------------------------------------------------
-- DESIGNATIONS — optionally scoped to a department (nullable: many
-- designations, e.g. "Accountant", are not department-specific).
-- ------------------------------------------------------------
create table designations (
  id               bigserial primary key,
  designation_code text        not null unique,
  designation_name text        not null,
  department_id    bigint      references departments(id),
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index idx_designations_department on designations(department_id);
create index idx_designations_active on designations(is_active);

-- ------------------------------------------------------------
-- EMPLOYMENT TYPES (Full-time, Part-time, Contract, Intern, ...)
-- ------------------------------------------------------------
create table employment_types (
  id                    bigserial primary key,
  employment_type_code  text        not null unique,
  employment_type_name  text        not null,
  is_active             boolean     not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ------------------------------------------------------------
-- BRANCHES — physical/legal work locations. Holidays and shifts
-- can be branch-specific below.
-- ------------------------------------------------------------
create table branches (
  id           bigserial primary key,
  branch_code  text        not null unique,
  branch_name  text        not null,
  address      text,
  city         text,
  state        text,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_branches_active on branches(is_active);

-- ------------------------------------------------------------
-- COST CENTERS — optionally tied to a department. Deliberately NOT
-- given accounting-side behavior in this milestone (no FK from
-- journal_entry_lines yet) — that wiring is a future, explicit
-- cross-module decision, not something to sneak in here.
-- ------------------------------------------------------------
create table cost_centers (
  id                bigserial primary key,
  cost_center_code  text        not null unique,
  cost_center_name  text        not null,
  department_id     bigint      references departments(id),
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_cost_centers_department on cost_centers(department_id);

-- ------------------------------------------------------------
-- SHIFTS
-- ------------------------------------------------------------
create table shifts (
  id             bigserial primary key,
  shift_code     text        not null unique,
  shift_name     text        not null,
  start_time     time        not null,
  end_time       time        not null,
  break_minutes  int         not null default 0 check (break_minutes >= 0),
  is_active      boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ------------------------------------------------------------
-- HOLIDAY CALENDAR — branch_id null means "applies to all branches".
-- Note on uniqueness: Postgres unique indexes treat NULL as distinct
-- from any other NULL, so a plain unique(holiday_date, branch_id)
-- would NOT catch two all-branch holidays on the same date. A
-- partial unique index below covers the branch_id IS NOT NULL case;
-- the all-branches (NULL) case is checked in application code
-- (routes/hr/holidays.ts) before insert. Documented here so it isn't
-- mistaken for an oversight later.
-- ------------------------------------------------------------
create table holidays (
  id            bigserial primary key,
  holiday_date  date        not null,
  holiday_name  text        not null,
  branch_id     bigint      references branches(id),
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index idx_holidays_date_branch_notnull on holidays(holiday_date, branch_id) where branch_id is not null;
create index idx_holidays_date on holidays(holiday_date);
create index idx_holidays_branch on holidays(branch_id);

-- ------------------------------------------------------------
-- SALARY COMPONENTS — building blocks for salary structures.
-- Calculation is Payroll milestone's job; this table only defines
-- what a component IS, not how it nets out for a given employee.
-- ------------------------------------------------------------
create table salary_components (
  id                bigserial primary key,
  component_code    text        not null unique,
  component_name    text        not null,
  component_type    text        not null check (component_type in ('earning','deduction')),
  calculation_type  text        not null check (calculation_type in ('fixed','percentage','formula')),
  is_taxable        boolean     not null default true,
  affects_net_pay   boolean     not null default true,
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_salary_components_type on salary_components(component_type);

-- ------------------------------------------------------------
-- SALARY STRUCTURES — a named template made of components. The
-- actual assignment of a structure to an employee, and the payroll
-- run that derives amounts from it, are Payroll-milestone concerns.
-- ------------------------------------------------------------
create table salary_structures (
  id              bigserial primary key,
  structure_code  text        not null unique,
  structure_name  text        not null,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table salary_structure_components (
  id            bigserial primary key,
  structure_id  bigint        not null references salary_structures(id) on delete cascade,
  component_id  bigint        not null references salary_components(id),
  amount        numeric(18,2),
  percentage    numeric(5,2),
  sequence      int           not null default 0,
  created_at    timestamptz   not null default now(),
  unique (structure_id, component_id),
  check (amount is not null or percentage is not null)
);
create index idx_ssc_structure on salary_structure_components(structure_id);
create index idx_ssc_component on salary_structure_components(component_id);

-- ------------------------------------------------------------
-- LEAVE TYPES
-- ------------------------------------------------------------
create table leave_types (
  id                       bigserial primary key,
  leave_type_code          text        not null unique,
  leave_type_name          text        not null,
  accrual_frequency        text        not null default 'yearly' check (accrual_frequency in ('monthly','yearly','none')),
  default_annual_days      numeric(5,2) not null default 0,
  allow_carry_forward      boolean     not null default false,
  max_carry_forward_days   numeric(5,2),
  allow_encashment         boolean     not null default false,
  is_active                boolean     not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ------------------------------------------------------------
-- ATTENDANCE STATUSES (Present, Absent, Half Day, On Leave, Holiday,
-- Week Off, ...) — configurable rather than hardcoded, since the
-- Attendance milestone's import engine needs to map vendor status
-- text onto these.
-- ------------------------------------------------------------
create table attendance_statuses (
  id           bigserial primary key,
  status_code  text        not null unique,
  status_name  text        not null,
  is_paid      boolean     not null default true,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ------------------------------------------------------------
-- DOCUMENT TYPES (PAN Card, Aadhaar, Offer Letter, ...) — referenced
-- by Milestone 2's employee_documents table.
-- ------------------------------------------------------------
create table document_types (
  id                  bigserial primary key,
  document_type_code  text        not null unique,
  document_type_name  text        not null,
  is_mandatory        boolean     not null default false,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ============================================================
-- Permission rows for this module. Depends on schema-permissions.sql.
-- Convention: two permission codes per resource — `.view` (read) and
-- `.manage` (create/update/deactivate). Assigned to HR_ADMIN (both)
-- and HR_VIEWER (view only) so the framework's least-privilege role
-- is exercised by something real from day one, not just SYSTEM_ADMIN.
-- ============================================================
insert into permissions (permission_code, module, description) values
  ('hr.department.view',        'hr', 'View departments.'),
  ('hr.department.manage',      'hr', 'Create, update, deactivate departments.'),
  ('hr.designation.view',       'hr', 'View designations.'),
  ('hr.designation.manage',     'hr', 'Create, update, deactivate designations.'),
  ('hr.employment_type.view',   'hr', 'View employment types.'),
  ('hr.employment_type.manage', 'hr', 'Create, update, deactivate employment types.'),
  ('hr.branch.view',            'hr', 'View branches.'),
  ('hr.branch.manage',          'hr', 'Create, update, deactivate branches.'),
  ('hr.cost_center.view',       'hr', 'View cost centers.'),
  ('hr.cost_center.manage',     'hr', 'Create, update, deactivate cost centers.'),
  ('hr.shift.view',             'hr', 'View shifts.'),
  ('hr.shift.manage',           'hr', 'Create, update, deactivate shifts.'),
  ('hr.holiday.view',           'hr', 'View holiday calendar.'),
  ('hr.holiday.manage',         'hr', 'Create, update, deactivate holidays.'),
  ('hr.salary_component.view',  'hr', 'View salary components.'),
  ('hr.salary_component.manage','hr', 'Create, update, deactivate salary components.'),
  ('hr.salary_structure.view',  'hr', 'View salary structures.'),
  ('hr.salary_structure.manage','hr', 'Create, update, deactivate salary structures and their components.'),
  ('hr.leave_type.view',        'hr', 'View leave types.'),
  ('hr.leave_type.manage',      'hr', 'Create, update, deactivate leave types.'),
  ('hr.attendance_status.view', 'hr', 'View attendance statuses.'),
  ('hr.attendance_status.manage','hr','Create, update, deactivate attendance statuses.'),
  ('hr.document_type.view',     'hr', 'View document types.'),
  ('hr.document_type.manage',   'hr', 'Create, update, deactivate document types.')
on conflict (permission_code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_ADMIN' and p.module = 'hr'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_VIEWER' and p.module = 'hr' and p.permission_code like '%.view'
on conflict do nothing;
