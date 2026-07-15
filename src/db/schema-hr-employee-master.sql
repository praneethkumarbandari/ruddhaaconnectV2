-- ============================================================
-- RUDDHAA ERP — HR MODULE, MILESTONE 2: EMPLOYEE MASTER & PROFILE
--
-- Additive only. Depends on schema.sql (employees), schema-permissions.sql
-- (roles/permissions), and schema-hr-masters.sql (departments,
-- designations, branches, cost_centers, employment_types, shifts,
-- document_types) having already run.
--
-- ARCHITECTURE DECISION — read before touching this file:
-- `employees` (schema.sql) is NOT renamed, dropped, recreated, or
-- altered here. Its primary key, username/password_hash/email/
-- is_active columns, and every existing query against it (auth.ts's
-- login, Project Management's created_by/assignee_id FKs, Milestone
-- 1's user_roles.employee_id) are untouched. It remains the Identity
-- table.
--
-- The Employee Master is built as a 1:1 EXTENSION — `employee_master`
-- has `employee_id` as its own PRIMARY KEY, itself a foreign key to
-- employees(id). This is a profile table, not a second identity
-- table: one row here can only ever correspond to exactly one
-- employees row.
--
-- REVISED after the Architecture Review Gate (see
-- HR_MODULE_ARCHITECTURE_REVIEW.md, Section 1): every employee_id FK
-- in this file to employees(id) was originally `on delete cascade`.
-- That's now removed (default RESTRICT) — this codebase's own
-- established convention is "never hard-delete, only deactivate"
-- (chart_of_accounts, customers, vendors, and employees.is_active
-- all follow this); the Phase 1 README documents journal_entry_lines
-- being changed FROM cascade TO RESTRICT for exactly this reason: a
-- cascade silently agrees to a blast radius — here, 11 tables of HR
-- history — the moment someone deletes an employees row, which is
-- also not exposed by any route today. RESTRICT means an attempt to
-- delete an employees row that has HR history simply fails loudly,
-- which is the correct default until deletion is an intentional,
-- reviewed feature.
--
-- Why a 1:1 table instead of just adding nullable columns onto
-- `employees` directly: `employees` is shared, high-traffic
-- infrastructure (every authenticated request reads it implicitly
-- via the JWT's userId, and it's an FK target from three other
-- modules already). Bolting ~15 HR-specific columns onto it would
-- couple the auth/identity table's shape to HR's evolution — every
-- future HR field (and Milestone 2 has many) would be a migration
-- against the table every other module depends on. A 1:1 table
-- keeps `employees` exactly as stable as it is today while giving HR
-- room to grow independently. This is the same reasoning Project
-- Management used for `project_id` columns vs. a generic dimension
-- table, applied in the opposite direction: there, additive nullable
-- columns were the simplest fit; here, a separate table is, because
-- what's being added is a whole owned domain (Employee Master), not
-- one dimension tag.
--
-- The remaining "Employee Profile" data (address, contact, emergency
-- contacts, education, experience, skills, certifications, documents,
-- bank details, statutory details, assets) is further normalized into
-- its own child/1:1 tables below rather than jammed into
-- employee_master, for the ordinary relational reason: several of
-- these are naturally one-to-many (an employee has 2 addresses, N
-- education records, N experience records, N skills, N certifications,
-- N documents, N assets) and cramming them into a single wide table
-- would mean either array/JSONB columns (harder to query, validate,
-- and index) or silently capping cardinality. The genuinely 1:1 pieces
-- (contact details, bank details, statutory details) get their own
-- 1:1 tables rather than columns on employee_master for a narrower
-- reason: bank and statutory details are sensitive and are gated by a
-- stricter permission (hr.employee.sensitive.*) than the rest of the
-- profile — separate tables make that permission boundary enforceable
-- per-query without column-level security.
-- ============================================================

-- ------------------------------------------------------------
-- EMPLOYEE MASTER
-- ------------------------------------------------------------
create table employee_master (
  employee_id           bigint      primary key references employees(id),
  employee_code         text        not null unique,
  date_of_birth         date,
  gender                text        check (gender in ('male','female','other','prefer_not_to_say')),
  department_id         bigint      references departments(id),
  designation_id        bigint      references designations(id),
  branch_id             bigint      references branches(id),
  cost_center_id        bigint      references cost_centers(id),
  employment_type_id    bigint      references employment_types(id),
  shift_id              bigint      references shifts(id),
  -- Self-referencing onto employees(id), not employee_master(employee_id)
  -- directly — but see the trigger below: a manager must actually have
  -- an employee_master row too, enforced in application code (lib/employees.ts)
  -- rather than a second FK, because Postgres can't express "must also
  -- exist in this same table, but not via its own primary key" cleanly
  -- against a table whose PK IS employee_id — a self-FK on employee_id
  -- to employee_id would work, but reporting_manager_id should remain
  -- valid even in the moment a manager's own employee_master row is
  -- being created in the same transaction (ordering), so the identity
  -- table is the more permissive, correct FK target.
  --
  -- Architecture Review Gate finding: this FK alone only proves the
  -- proposed manager is SOME identity row (even a login-only account
  -- with no employee_master row, if one ever existed). Application
  -- code (lib/employees.ts validateReportingManager) was tightened to
  -- additionally require an employee_master row for the proposed
  -- manager — a real HR employee, not just any authenticated
  -- identity — since a DB-level constraint can't express "must also
  -- exist in this other table's rows" as cleanly as a query can. See
  -- HR_MODULE_ARCHITECTURE_REVIEW.md Section 2.
  reporting_manager_id  bigint      references employees(id),
  status                text        not null default 'active'
                          check (status in ('active','on_notice','suspended','exited')),
  joining_date          date        not null,
  confirmation_date     date,
  exit_date             date,
  photo_url             text,
  remarks               text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint chk_not_own_manager check (reporting_manager_id is null or reporting_manager_id <> employee_id),
  constraint chk_confirmation_after_joining check (confirmation_date is null or confirmation_date >= joining_date),
  constraint chk_exit_after_joining check (exit_date is null or exit_date >= joining_date),
  -- One-directional on purpose: exited employees must have an exit
  -- date, but an exit_date may be recorded in advance (e.g. during
  -- notice period) without status having flipped to 'exited' yet.
  constraint chk_exit_date_required_if_exited check (status <> 'exited' or exit_date is not null)
);

create index idx_employee_master_department on employee_master(department_id);
create index idx_employee_master_designation on employee_master(designation_id);
create index idx_employee_master_branch on employee_master(branch_id);
create index idx_employee_master_cost_center on employee_master(cost_center_id);
create index idx_employee_master_manager on employee_master(reporting_manager_id);
create index idx_employee_master_status on employee_master(status);
-- No separate index on employee_code: the `unique` constraint above
-- already creates one (Postgres builds a unique btree index to
-- enforce it). A second explicit index on the same column would be
-- redundant — pure write overhead with zero read benefit. Flagged
-- and removed during the Architecture Review Gate.

-- ------------------------------------------------------------
-- ADDRESSES — current + permanent, not a generic address book.
-- ------------------------------------------------------------
create table employee_addresses (
  id            bigserial   primary key,
  employee_id   bigint      not null references employees(id),
  address_type  text        not null check (address_type in ('current','permanent')),
  line1         text        not null,
  line2         text,
  city          text,
  state         text,
  pincode       text,
  country       text        not null default 'India',
  updated_at    timestamptz not null default now(),
  unique (employee_id, address_type)
);
create index idx_employee_addresses_employee on employee_addresses(employee_id);

-- ------------------------------------------------------------
-- CONTACT DETAILS — 1:1. personal_email is deliberately separate
-- from employees.email (the login identifier) — an employee's work
-- login email and personal contact email are different concepts and
-- the login one must never be edited through an HR profile screen.
-- ------------------------------------------------------------
create table employee_contact_details (
  employee_id     bigint      primary key references employees(id),
  personal_email  text,
  personal_phone  text,
  alternate_phone text,
  updated_at      timestamptz not null default now()
);
create unique index idx_employee_contact_personal_email on employee_contact_details(personal_email) where personal_email is not null;

-- ------------------------------------------------------------
-- EMERGENCY CONTACTS — one-to-many, at most one primary.
-- ------------------------------------------------------------
create table employee_emergency_contacts (
  id             bigserial   primary key,
  employee_id    bigint      not null references employees(id),
  contact_name   text        not null,
  relationship   text,
  phone_number   text        not null,
  is_primary     boolean     not null default false,
  created_at     timestamptz not null default now()
);
create index idx_emergency_contacts_employee on employee_emergency_contacts(employee_id);
create unique index idx_emergency_contacts_one_primary on employee_emergency_contacts(employee_id) where is_primary = true;

-- ------------------------------------------------------------
-- EDUCATION
-- ------------------------------------------------------------
create table employee_education (
  id                bigserial   primary key,
  employee_id       bigint      not null references employees(id),
  qualification     text        not null,
  institution        text,
  specialization    text,
  year_of_passing   int,
  grade             text,
  created_at        timestamptz not null default now()
);
create index idx_education_employee on employee_education(employee_id);

-- ------------------------------------------------------------
-- EXPERIENCE
-- ------------------------------------------------------------
create table employee_experience (
  id            bigserial   primary key,
  employee_id   bigint      not null references employees(id),
  company_name  text        not null,
  designation   text,
  from_date     date        not null,
  to_date       date,
  description   text,
  created_at    timestamptz not null default now(),
  check (to_date is null or to_date >= from_date)
);
create index idx_experience_employee on employee_experience(employee_id);

-- ------------------------------------------------------------
-- SKILLS
-- ------------------------------------------------------------
create table employee_skills (
  id                 bigserial   primary key,
  employee_id        bigint      not null references employees(id),
  skill_name         text        not null,
  proficiency_level  text        check (proficiency_level in ('beginner','intermediate','advanced','expert')),
  created_at         timestamptz not null default now(),
  unique (employee_id, skill_name)
);
create index idx_skills_employee on employee_skills(employee_id);

-- ------------------------------------------------------------
-- CERTIFICATIONS
-- ------------------------------------------------------------
create table employee_certifications (
  id                    bigserial   primary key,
  employee_id           bigint      not null references employees(id),
  certification_name    text        not null,
  issued_by             text,
  issued_date           date,
  expiry_date           date,
  certificate_number    text,
  created_at            timestamptz not null default now(),
  check (expiry_date is null or issued_date is null or expiry_date >= issued_date)
);
create index idx_certifications_employee on employee_certifications(employee_id);

-- ------------------------------------------------------------
-- DOCUMENTS — references document_types from Milestone 1. No file
-- storage engine exists in this codebase yet (Netlify Functions have
-- no persistent filesystem), so file_reference is a plain text field
-- (an external URL/object-storage key) rather than a binary column or
-- multer upload target — same "simplest structure matching an actual
-- requirement" call, since building a file storage layer is a real,
-- separate decision this milestone doesn't make on Praneeth's behalf.
-- ------------------------------------------------------------
create table employee_documents (
  id                bigserial   primary key,
  employee_id       bigint      not null references employees(id),
  document_type_id  bigint      not null references document_types(id),
  document_number   text,
  file_reference    text,
  issued_date       date,
  expiry_date       date,
  is_verified       boolean     not null default false,
  uploaded_at       timestamptz not null default now()
);
create index idx_documents_employee on employee_documents(employee_id);
create index idx_documents_type on employee_documents(document_type_id);
-- Added during the Architecture Review Gate: a future compliance
-- report ("documents expiring in the next N days") is an obvious,
-- likely Milestone 3+ need, and a partial index on the non-null
-- expiry dates costs almost nothing today while avoiding a full
-- table scan later.
create index idx_documents_expiry on employee_documents(expiry_date) where expiry_date is not null;

-- ------------------------------------------------------------
-- BANK DETAILS — 1:1, sensitive (see hr.employee.sensitive.* below).
-- ------------------------------------------------------------
create table employee_bank_details (
  employee_id          bigint      primary key references employees(id),
  bank_name            text,
  account_number       text,
  ifsc_code            text,
  account_holder_name  text,
  branch_name          text,
  updated_at           timestamptz not null default now()
);

-- ------------------------------------------------------------
-- STATUTORY DETAILS — 1:1, sensitive. Partial unique indexes prevent
-- the same PAN/Aadhaar being recorded against two different
-- employees, without forcing every employee to have one (contractors/
-- interns may not yet have all statutory IDs on file).
-- ------------------------------------------------------------
create table employee_statutory_details (
  employee_id     bigint      primary key references employees(id),
  pan_number      text,
  aadhaar_number  text,
  uan_number      text,
  pf_number       text,
  esi_number      text,
  pt_applicable   boolean     not null default true,
  updated_at      timestamptz not null default now()
);
create unique index idx_statutory_pan on employee_statutory_details(pan_number) where pan_number is not null;
create unique index idx_statutory_aadhaar on employee_statutory_details(aadhaar_number) where aadhaar_number is not null;

-- ------------------------------------------------------------
-- ASSETS ISSUED — denormalized asset_name/asset_code rather than a
-- FK to a shared asset-inventory master, because no such registry
-- exists or has been requested yet; this only tracks what's been
-- handed to whom, not a company-wide asset ledger.
-- ------------------------------------------------------------
create table employee_assets (
  id               bigserial   primary key,
  employee_id      bigint      not null references employees(id),
  asset_name       text        not null,
  asset_code       text,
  issued_date      date        not null,
  returned_date    date,
  condition_notes  text,
  created_at       timestamptz not null default now(),
  check (returned_date is null or returned_date >= issued_date)
);
create index idx_assets_employee on employee_assets(employee_id);

-- ============================================================
-- Permission rows. Depends on schema-permissions.sql having run.
-- hr.employee.* covers Employee Master + the non-sensitive profile
-- sections (address/contact/emergency/education/experience/skills/
-- certifications) as one group, matching how the spec itself groups
-- "Employee Master" and "Employee Profile" together conceptually.
-- Documents and Assets get their own codes (spec lists them as
-- separate API groups). Bank + statutory get a stricter, separate
-- "sensitive" code, NOT granted to HR_VIEWER, unlike everything else.
-- ============================================================
insert into permissions (permission_code, module, description) values
  ('hr.employee.view',            'hr', 'View employee master records and non-sensitive profile data.'),
  ('hr.employee.manage',          'hr', 'Create, update, deactivate employee master records and non-sensitive profile data.'),
  ('hr.employee_document.view',   'hr', 'View employee documents.'),
  ('hr.employee_document.manage', 'hr', 'Upload/record and remove employee documents.'),
  ('hr.employee_asset.view',      'hr', 'View employee asset assignments.'),
  ('hr.employee_asset.manage',    'hr', 'Issue and return employee assets.'),
  ('hr.employee.sensitive.view',  'hr', 'View employee bank and statutory details.'),
  ('hr.employee.sensitive.manage','hr', 'Create/update employee bank and statutory details.')
on conflict (permission_code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_ADMIN'
  and p.permission_code in (
    'hr.employee.view', 'hr.employee.manage',
    'hr.employee_document.view', 'hr.employee_document.manage',
    'hr.employee_asset.view', 'hr.employee_asset.manage',
    'hr.employee.sensitive.view', 'hr.employee.sensitive.manage'
  )
on conflict do nothing;

-- HR_VIEWER gets view access to Employee Master, documents, and
-- assets — but NOT hr.employee.sensitive.view. Least-privilege by
-- default: viewing who works where is routine; viewing bank account
-- numbers is not, even read-only.
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_VIEWER'
  and p.permission_code in ('hr.employee.view', 'hr.employee_document.view', 'hr.employee_asset.view')
on conflict do nothing;
