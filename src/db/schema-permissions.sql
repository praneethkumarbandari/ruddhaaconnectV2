-- ============================================================
-- RUDDHAA ERP — PERMISSION FRAMEWORK (ERP FOUNDATION, not an HR table)
--
-- Additive only. No existing table (chart_of_accounts, employees,
-- customers, journal_entries, project_management tables, etc.) is
-- altered here.
--
-- This is explicitly module-independent infrastructure. Any module
-- (accounting, hr, inventory, crm, project_management, lucky) can
-- register its own permission_code rows under its own `module`
-- value and gate its routes with requirePermission() from
-- src/lib/permissions.ts — nothing here is HR-specific.
--
-- Identity anchor: employees.id. There is no separate "users" table
-- in this system — employees ARE the system users (this is already
-- assumed by schema-projectmanagement.sql's created_by/assignee_id
-- FKs into employees(id)), so user_roles hangs off employees.id
-- rather than introducing a second identity concept.
--
-- Rollout discipline (per explicit instruction): creating this
-- schema does NOT change behavior for any existing route. Every
-- current endpoint in chart-of-accounts.ts, customers.ts, sales.ts,
-- etc. keeps working exactly as before — requireAuth (WHO) is
-- unchanged, and nothing here is wired into those routers. Only
-- new HR routes (Milestone 1 onward) call requirePermission (WHAT).
-- Enabling permission checks on other modules later is a routing
-- change in that module's own route file, not a schema change here.
-- ============================================================

create table roles (
  id             bigserial primary key,
  role_code      text        not null unique,      -- e.g. 'HR_ADMIN', 'PAYROLL_CLERK' — stable, referenced by seeds/code
  role_name      text        not null,              -- display label, editable
  description    text,
  is_system      boolean     not null default false, -- seeded roles: not deletable via API, same convention as chart_of_accounts.is_system
  is_active      boolean     not null default true,
  -- Optional single-parent inheritance: a role with a parent inherits
  -- every permission the parent (and the parent's parent, etc.) has.
  -- Kept as a plain nullable self-FK rather than a many-parent graph
  -- because no real requirement for multiple inheritance exists yet —
  -- same "simplest structure that matches an actual requirement" call
  -- Project Management made for project_id over a generic dimension table.
  parent_role_id bigint      references roles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table permissions (
  id               bigserial primary key,
  permission_code  text        not null unique,   -- 'hr.department.manage', 'accounting.journal_entry.post', ...
  module           text        not null,           -- 'hr' | 'accounting' | 'inventory' | 'crm' | 'project_management' | 'lucky' | 'admin'
  description      text,
  created_at       timestamptz not null default now()
);

create table role_permissions (
  role_id       bigint      not null references roles(id) on delete cascade,
  permission_id bigint      not null references permissions(id) on delete cascade,
  granted_at    timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table user_roles (
  employee_id bigint      not null references employees(id) on delete cascade,
  role_id     bigint      not null references roles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by bigint      references employees(id),
  primary key (employee_id, role_id)
);

-- ------------------------------------------------------------
-- Approval hierarchies — generic, not HR-specific. Any module's
-- draft/approval workflow (HR leave, Lucky-originated drafts, a
-- future Project Management budget-approval flow) references this
-- instead of each module inventing its own approval-chain table.
-- This table only defines WHO can approve at each level for a named
-- workflow; the actual draft/request records (leave_requests,
-- lucky drafts, etc.) live in their own module's schema and store
-- which hierarchy + level they're currently sitting at.
-- ------------------------------------------------------------
create table approval_hierarchies (
  id             bigserial primary key,
  hierarchy_code text        not null unique,   -- e.g. 'HR_LEAVE_APPROVAL', 'LUCKY_DRAFT_APPROVAL'
  module         text        not null,
  description    text,
  is_active      boolean     not null default true,
  created_at     timestamptz not null default now()
);

-- Architecture Review Gate finding (see HR_MODULE_ARCHITECTURE_REVIEW.md
-- Section 3): the original version of this table could only express
-- "anyone holding role X approves this step." That covers escalation
-- to a fixed role (e.g. "HR_ADMIN signs off"), but the single most
-- common real approval pattern — "the requester's own reporting
-- manager approves first" — cannot be expressed by a fixed role at
-- all, since who that is varies per requester. Revised before any
-- code consumes this table (nothing does yet), specifically so Leave
-- Management doesn't inherit a shape that can't support its most
-- basic workflow. approver_type discriminates the two cases;
-- approver_role_id is only required (and only meaningful) when
-- approver_type = 'role'.
create table approval_hierarchy_levels (
  id               bigserial primary key,
  hierarchy_id     bigint      not null references approval_hierarchies(id) on delete cascade,
  level_order      int         not null,             -- 1 = first approver, 2 = escalation, ...
  approver_type    text        not null default 'role' check (approver_type in ('role', 'reporting_manager')),
  approver_role_id bigint      references roles(id),
  description      text,
  unique (hierarchy_id, level_order),
  check ((approver_type = 'role' and approver_role_id is not null) or (approver_type = 'reporting_manager' and approver_role_id is null))
);

create index idx_role_permissions_role       on role_permissions(role_id);
create index idx_role_permissions_permission on role_permissions(permission_id);
create index idx_user_roles_employee         on user_roles(employee_id);
create index idx_user_roles_role             on user_roles(role_id);
create index idx_permissions_module          on permissions(module);
create index idx_roles_parent                on roles(parent_role_id);
create index idx_approval_levels_hierarchy   on approval_hierarchy_levels(hierarchy_id);

-- ------------------------------------------------------------
-- Seed: minimal system roles. SYSTEM_ADMIN is a hard-coded bypass
-- in src/lib/permissions.ts (holds every permission implicitly,
-- including ones registered by modules after this migration ran) —
-- it deliberately has no role_permissions rows, so a new module's
-- permission codes don't require re-granting SYSTEM_ADMIN each time.
-- ------------------------------------------------------------
insert into roles (role_code, role_name, description, is_system) values
  ('SYSTEM_ADMIN', 'System Administrator', 'Full access to every module. Bypasses permission checks; see lib/permissions.ts.', true),
  ('HR_ADMIN',     'HR Administrator',     'Full manage access to HR module masters and records.', true),
  ('HR_VIEWER',    'HR Viewer',            'Read-only access to HR module masters and records.', true),
  ('EMPLOYEE',     'Employee',             'Baseline role for every employee. Self-service access only.', true)
on conflict (role_code) do nothing;

-- Permission to administer the RBAC framework itself (create roles,
-- grant permissions, assign roles to employees) — deliberately not
-- granted to HR_ADMIN, since "who can configure permissions" is a
-- narrower, higher-trust capability than "who can administer HR data".
insert into permissions (permission_code, module, description) values
  ('admin.rbac.manage', 'admin', 'Create/edit roles, grant or revoke permissions, assign roles to employees.'),
  ('admin.rbac.view',   'admin', 'View roles, permissions, and role assignments.')
on conflict (permission_code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'SYSTEM_ADMIN' and p.permission_code in ('admin.rbac.manage', 'admin.rbac.view')
on conflict do nothing;

-- ------------------------------------------------------------
-- Bootstrap note (manual, one-time, per environment):
-- This migration seeds roles/permissions but deliberately does NOT
-- assign SYSTEM_ADMIN to any employee — there is no safe automatic
-- choice of "which employee is the admin" from schema alone. After
-- running this migration, assign it once by hand:
--
--   insert into user_roles (employee_id, role_id)
--   select <your-employee-id>, id from roles where role_code = 'SYSTEM_ADMIN';
--
-- Until that row exists, admin.rbac.* endpoints are unreachable by
-- anyone (correct fail-closed behavior, not a bug).
-- ------------------------------------------------------------
