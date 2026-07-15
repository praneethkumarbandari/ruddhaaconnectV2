-- ============================================================
-- RUDDHAA ERP — HR MODULE, MILESTONE 3: ATTENDANCE ENGINE
--
-- Additive only. Depends on schema.sql, schema-permissions.sql,
-- schema-hr-masters.sql, schema-hr-employee-master.sql all having run.
--
-- SCOPE NOTE — masters actually needed, and ones deliberately NOT
-- built as new tables because they already exist:
-- - "Attendance Status Rules" -> reuses Milestone 1's
--   `attendance_statuses` table (extended with more seed rows below,
--   no schema change to that table). A second status concept would
--   be a duplicate of an existing master.
-- - "Holiday Assignment" -> reuses Milestone 1's `holidays` table
--   (already branch-scoped). Attendance processing looks up holidays
--   by the employee's branch_id; no new table needed.
-- - "Shift Calendar" -> NOT a stored table. It's a derived view —
--   which shift applies to which employee on which date — computed
--   from employee_shift_assignments + shift_overrides at query time,
--   consistent with this codebase's "reports are derived, never
--   stored" discipline (see lib/attendance.ts's getShiftForDate()).
-- - "Grace Time Rules", "Late Entry Rules", "Early Exit Rules",
--   "Overtime Rules" -> consolidated into ONE `attendance_policies`
--   table as columns, not four separate one-row-per-policy tables.
--   These are facets of a single policy configuration, not
--   independent entities with their own lifecycle — four tables here
--   would be over-normalization for what one policy record already
--   captures. Same "simplest structure matching an actual
--   requirement" reasoning used throughout this codebase (Project
--   Management's project_id, HR's employee status enum).
-- ============================================================

-- ------------------------------------------------------------
-- ATTENDANCE POLICIES (consolidates grace/late/early/overtime rules)
-- ------------------------------------------------------------
create table attendance_policies (
  id                          bigserial   primary key,
  policy_code                 text        not null unique,
  policy_name                 text        not null,
  grace_minutes               int         not null default 0 check (grace_minutes >= 0),
  half_day_threshold_hours    numeric(4,2) not null default 4.00,
  full_day_threshold_hours    numeric(4,2) not null default 8.00,
  overtime_enabled            boolean     not null default false,
  overtime_threshold_minutes  int         not null default 0 check (overtime_threshold_minutes >= 0),
  min_overtime_minutes        int         not null default 30 check (min_overtime_minutes >= 0),
  is_active                   boolean     not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  check (half_day_threshold_hours < full_day_threshold_hours)
);

-- Additive column onto Milestone 1's shifts table — same pattern
-- Project Management used for project_id on existing accounting
-- tables: a nullable FK added by the module that needs it, not a
-- rewrite of the original schema file. Nullable because not every
-- shift needs a policy (falls back to a system default, resolved in
-- code — see lib/attendance-processing.ts).
alter table shifts add column attendance_policy_id bigint references attendance_policies(id);

-- System default policy, resolved by code (not hardcoded ID) whenever
-- a shift has no attendance_policy_id set, or no shift resolves at
-- all for a given date — see lib/attendance-processing.ts's
-- getPolicyForShift(). Conservative defaults: no grace period, no
-- overtime unless a tenant explicitly configures a policy that
-- enables it.
insert into attendance_policies (policy_code, policy_name, grace_minutes, half_day_threshold_hours, full_day_threshold_hours, overtime_enabled)
values ('DEFAULT', 'Default Policy', 0, 4.00, 8.00, false)
on conflict (policy_code) do nothing;

-- ------------------------------------------------------------
-- EMPLOYEE SHIFT ASSIGNMENT — date-ranged, so shift ROTATION is just
-- multiple rows with adjacent date ranges, not a separate "rotation"
-- concept. Cross-day/night shifts are a property of the shift itself
-- (shifts.start_time > shifts.end_time in schema-hr-masters.sql
-- already implicitly allows this; see lib/attendance-processing.ts
-- for how attendance_records' timestamptz columns resolve which
-- calendar date a night-shift punch belongs to).
-- ------------------------------------------------------------
create table employee_shift_assignments (
  id              bigserial   primary key,
  employee_id     bigint      not null references employees(id),
  shift_id        bigint      not null references shifts(id),
  effective_from  date        not null,
  effective_to    date,
  created_by      bigint      references employees(id),
  created_at      timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create index idx_shift_assignments_employee on employee_shift_assignments(employee_id, effective_from);

-- Prevents two overlapping assignments for the same employee — an
-- employee can't be on two shifts at once. Must be an EXCLUDE
-- constraint, not a plain index: a plain GIST index only accelerates
-- range-overlap queries, it does not reject overlapping inserts. This
-- uses the exact same mechanism schema.sql already established for
-- financial_years' overlap prevention (`exclude using gist`), applied
-- here instead of a hand-rolled overlap check in application code.
alter table employee_shift_assignments add constraint excl_shift_assignment_overlap
  exclude using gist (
    employee_id with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
  );

-- ------------------------------------------------------------
-- SHIFT OVERRIDES — a single specific date's shift differs from the
-- employee's standing assignment (a one-off swap), without altering
-- the underlying assignment history.
-- ------------------------------------------------------------
create table shift_overrides (
  id             bigserial   primary key,
  employee_id    bigint      not null references employees(id),
  override_date  date        not null,
  shift_id       bigint      not null references shifts(id),
  reason         text,
  created_by     bigint      references employees(id),
  created_at     timestamptz not null default now(),
  unique (employee_id, override_date)
);

-- ------------------------------------------------------------
-- WEEKLY OFF CONFIGURATION — per employee. A branch-wide default
-- was considered and deliberately not built: no stated requirement
-- for it yet, and per-employee rows already cover the real case
-- (most employees share the same day, some don't) without a second
-- fallback-resolution layer to maintain. day_of_week: 0=Sunday .. 6=Saturday.
-- ------------------------------------------------------------
create table weekly_off_configurations (
  id            bigserial   primary key,
  employee_id   bigint      not null references employees(id),
  day_of_week   int         not null check (day_of_week between 0 and 6),
  created_at    timestamptz not null default now(),
  unique (employee_id, day_of_week)
);
create index idx_weekly_off_employee on weekly_off_configurations(employee_id);

-- ============================================================
-- BIOMETRIC IMPORT ENGINE — deliberately mirrors
-- schema-bankimport.sql's mapping_templates -> import_batches ->
-- import_rows shape exactly, per the plan disclosed in
-- HR_MODULE_MILESTONE_1.md when the Bank Import Engine schema was
-- first noted as a near-exact structural match for what attendance
-- import would need.
-- ============================================================
create table attendance_mapping_templates (
  id             bigserial   primary key,
  template_name  text        not null unique,
  -- Maps each required logical field to the source file's column
  -- header text, e.g. {"employeeCode":"Emp Code","attendanceDate":"Date",
  -- "inTime":"In Time","outTime":"Out Time","shiftCode":"Shift",
  -- "deviceId":"Device","statusRaw":"Status"}. Vendor-independent by
  -- construction: nothing here or in lib/attendance-import.ts
  -- hardcodes a specific biometric vendor's column names.
  column_mapping jsonb       not null,
  created_by     bigint      references employees(id),
  created_at     timestamptz not null default now()
);

create table attendance_import_batches (
  id                   bigserial   primary key,
  file_name            text        not null,
  mapping_template_id  bigint      references attendance_mapping_templates(id),
  status               text        not null default 'previewed'
                          check (status in ('previewed', 'committed', 'rolled_back', 'failed')),
  total_rows           int         not null default 0,
  rows_valid           int         not null default 0,
  rows_rejected        int         not null default 0,
  rows_duplicate       int         not null default 0,
  rows_committed       int         not null default 0,
  imported_by          bigint      references employees(id),
  imported_at          timestamptz not null default now(),
  committed_at         timestamptz,
  rolled_back_at       timestamptz,
  rolled_back_by       bigint      references employees(id)
);

create table attendance_import_rows (
  id                   bigserial   primary key,
  batch_id             bigint      not null references attendance_import_batches(id),
  row_number           int         not null,
  employee_code_raw    text,
  employee_name_raw    text,
  attendance_date_raw  text,
  in_time_raw          text,
  out_time_raw         text,
  shift_code_raw       text,
  device_id            text,
  status_raw           text,
  -- Resolved once the row is validated against real HR data —
  -- nullable until then. A row can fail to resolve (unknown employee
  -- code) without failing to parse.
  resolved_employee_id bigint      references employees(id),
  resolved_shift_id    bigint      references shifts(id),
  attendance_date      date,
  status               text        not null default 'parsed'
                          -- Domain Review additions to the original
                          -- ('parsed','valid','rejected','duplicate','committed') set:
                          -- 'merged' — this row's punch was folded into
                          --   another row's aggregated first-in/last-out
                          --   for the same employee+date (see
                          --   validateAndResolveRows) rather than
                          --   discarded as a same-day duplicate. A
                          --   biometric export with one row per punch
                          --   event (in, out, in again after lunch, out)
                          --   is a real, common format this
                          --   distinguishes from a genuine duplicate.
                          -- 'commit_failed' — this row passed validation
                          --   but failed at commit time (e.g. the date
                          --   was locked between preview and commit).
                          --   Distinct from 'rejected' (a preview-time
                          --   verdict) so the two failure moments are
                          --   never conflated in the error log, and so
                          --   a subsequent commit attempt knows to
                          --   retry exactly these rows.
                          check (status in ('parsed', 'valid', 'rejected', 'duplicate', 'merged', 'commit_failed', 'committed')),
  rejection_reason     text,
  created_at           timestamptz not null default now()
);
create index idx_attendance_import_rows_batch on attendance_import_rows(batch_id);
create index idx_attendance_import_rows_status on attendance_import_rows(status);
-- Duplicate detection scope: same employee + same date, whether
-- already committed as a real attendance_records row OR already
-- present in a prior batch — checked in lib/attendance-import.ts
-- against both attendance_records and this table, not just one.
create index idx_attendance_import_rows_dupe_check on attendance_import_rows(resolved_employee_id, attendance_date);

-- ============================================================
-- ATTENDANCE RECORDS — the single source of truth. Every report in
-- this module (Section "Reports") derives from this table; nothing
-- is a stored daily/monthly summary.
--
-- Cross-day shift handling: in_timestamp/out_timestamp are full
-- `timestamptz`, not `time`, specifically so a night shift starting
-- 22:00 on attendance_date D and ending 06:00 the next calendar day
-- is stored correctly as one record keyed to D (the shift's logical
-- start date) — the alternative (plain `time` columns) cannot
-- distinguish "worked past midnight" from "worked before midnight"
-- without external context, which is exactly the bug class this
-- schema avoids by construction.
-- ============================================================
create table attendance_records (
  id                bigserial     primary key,
  employee_id       bigint        not null references employees(id),
  attendance_date   date          not null,
  shift_id          bigint        references shifts(id),
  in_timestamp      timestamptz,
  out_timestamp     timestamptz,
  status_id         bigint        not null references attendance_statuses(id),
  working_minutes   int,
  late_minutes      int           not null default 0,
  early_exit_minutes int          not null default 0,
  overtime_minutes  int           not null default 0,
  is_half_day       boolean       not null default false,
  source            text          not null check (source in ('biometric_import', 'manual', 'correction', 'leave')),
  import_batch_id   bigint        references attendance_import_batches(id),
  -- Milestone 4 (Leave Management) addition: precise, targeted
  -- reversal on leave cancellation needs to know exactly which
  -- attendance_records rows a given leave request created, the same
  -- way import_batch_id lets rollback target exactly one batch's rows
  -- without touching anything else. Nullable — only set when
  -- source = 'leave'.
  leave_request_id  bigint,
  -- Attendance Domain Validation Review finding: employee_master's
  -- department_id/branch_id/cost_center_id are CURRENT-STATE only —
  -- a transfer overwrites them with no history. A department-wise
  -- attendance/payroll report run today, for a date range spanning a
  -- transfer, would silently attribute the whole range to the
  -- employee's CURRENT department, not whichever one they were
  -- actually in on each date. Rather than build a full employee
  -- assignment-history table right now (a larger, separate,
  -- cross-milestone change — see the Payroll Readiness Assessment),
  -- these three columns snapshot the employee's department/branch/
  -- cost center AT THE TIME each attendance record is written,
  -- giving point-in-time accuracy for exactly what attendance and
  -- (future) payroll reports need, without waiting on that larger
  -- change. Nullable because an employee might have no department
  -- assigned at all — a valid state, not an error.
  department_id     bigint        references departments(id),
  branch_id         bigint        references branches(id),
  cost_center_id    bigint        references cost_centers(id),
  remarks           text,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  check (out_timestamp is null or in_timestamp is null or out_timestamp >= in_timestamp),
  unique (employee_id, attendance_date)
);
create index idx_attendance_records_employee_date on attendance_records(employee_id, attendance_date);
create index idx_attendance_records_date on attendance_records(attendance_date);
create index idx_attendance_records_status on attendance_records(status_id);
create index idx_attendance_records_batch on attendance_records(import_batch_id) where import_batch_id is not null;
-- Directly serves department-wise date-range reports (a named
-- Performance Review concern) without joining employee_master at
-- query time, and is the more CORRECT source for such a report per
-- the snapshot reasoning above, not just the faster one.
create index idx_attendance_records_department_date on attendance_records(department_id, attendance_date);

-- ============================================================
-- ATTENDANCE CORRECTIONS — consumes the generic approval framework
-- (approval_hierarchies / approval_hierarchy_levels, corrected during
-- the Architecture Review Gate specifically so this would be
-- buildable). "No direct database updates": the workflow's terminal
-- step is the only path that ever writes to attendance_records with
-- source='correction' — see lib/attendance-corrections.ts.
-- ============================================================
create table attendance_correction_requests (
  id                       bigserial   primary key,
  employee_id              bigint      not null references employees(id),
  attendance_date          date        not null,
  requested_in_timestamp   timestamptz,
  requested_out_timestamp  timestamptz,
  reason                   text        not null,
  status                   text        not null default 'pending'
                             check (status in ('pending', 'approved', 'rejected', 'applied')),
  current_level_order      int         not null default 1,
  requested_by             bigint      not null references employees(id),
  decided_by               bigint      references employees(id),
  decided_at               timestamptz,
  decision_notes           text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index idx_correction_requests_employee on attendance_correction_requests(employee_id);
create index idx_correction_requests_status on attendance_correction_requests(status);

insert into approval_hierarchies (hierarchy_code, module, description) values
  ('HR_ATTENDANCE_CORRECTION', 'hr', 'Attendance correction: reporting manager, then HR sign-off.')
on conflict (hierarchy_code) do nothing;

-- Level 1: the requester's own reporting manager (approver_type
-- fixed during the Architecture Review Gate specifically to make
-- this expressible). Level 2: any HR_ADMIN. "HR Approval (where
-- configured)" from the spec is handled by whether level 2 exists at
-- all, not a separate flag — deleting this row, if a tenant ever
-- wants single-level approval, is the configuration mechanism.
insert into approval_hierarchy_levels (hierarchy_id, level_order, approver_type, approver_role_id, description)
select h.id, 1, 'reporting_manager', null, 'Requester''s reporting manager'
from approval_hierarchies h where h.hierarchy_code = 'HR_ATTENDANCE_CORRECTION'
on conflict (hierarchy_id, level_order) do nothing;

insert into approval_hierarchy_levels (hierarchy_id, level_order, approver_type, approver_role_id, description)
select h.id, 2, 'role', r.id, 'HR sign-off'
from approval_hierarchies h, roles r
where h.hierarchy_code = 'HR_ATTENDANCE_CORRECTION' and r.role_code = 'HR_ADMIN'
on conflict (hierarchy_id, level_order) do nothing;

-- ============================================================
-- ATTENDANCE LOCKS
-- ------------------------------------------------------------
-- Soft-lock model: a lock is a row; unlocking sets is_active = false
-- rather than deleting, so the full lock/unlock history is preserved
-- for audit purposes without relying solely on audit_log (which also
-- records every lock/unlock action per the spec's audit requirement —
-- this table is queried for "is this date currently locked", audit_log
-- is queried for "who locked/unlocked this and when, historically").
-- period_date is the exact date for a 'daily' lock, or the first day
-- of the month for a 'monthly' lock (convention, not enforced by a
-- CHECK — enforced in lib/attendance-locks.ts where the row is created).
-- ============================================================
create table attendance_locks (
  id            bigserial   primary key,
  lock_type     text        not null check (lock_type in ('daily', 'monthly')),
  period_date   date        not null,
  is_active     boolean     not null default true,
  locked_by     bigint      not null references employees(id),
  locked_at     timestamptz not null default now(),
  unlocked_by   bigint      references employees(id),
  unlocked_at   timestamptz
);
create index idx_attendance_locks_active on attendance_locks(lock_type, period_date) where is_active = true;

-- ============================================================
-- Extend Milestone 1's attendance_statuses with the standard codes
-- the processing engine resolves against by CODE (not by hardcoded
-- ID, precisely so this seed order/presence is the only coupling —
-- see lib/attendance-processing.ts). Additive only: if any of these
-- codes already exist (a tenant customized them before this
-- milestone), `on conflict do nothing` leaves them untouched.
-- ============================================================
insert into attendance_statuses (status_code, status_name, is_paid) values
  ('PRESENT', 'Present', true),
  ('HALF_DAY', 'Half Day', true),
  ('ABSENT', 'Absent', false),
  ('HOLIDAY', 'Holiday', true),
  ('WEEKLY_OFF', 'Weekly Off', true),
  -- Domain Review addition: exactly one of in/out punched (the other
  -- missing) is no longer classified as ABSENT — that conflated
  -- "clearly didn't work" with "worked but the record is incomplete,"
  -- which is both factually wrong and, unresolved, a real payroll/LOP
  -- risk and a predictable source of employee grievances. is_paid is
  -- deliberately null/false-by-default (not automatically paid) —
  -- this status exists specifically to force HR's attention via the
  -- correction workflow, not to quietly resolve itself.
  ('INCOMPLETE', 'Incomplete Punch', false)
on conflict (status_code) do nothing;

-- ============================================================
-- Permission rows. Depends on schema-permissions.sql.
-- attendance.correction.request is granted to EMPLOYEE (the baseline
-- role every employee has) — self-service correction requests are
-- exactly the point of the workflow; everything else is HR-gated.
-- ============================================================
insert into permissions (permission_code, module, description) values
  ('attendance.master.view',       'attendance', 'View attendance policies, shift assignments, weekly-off configuration, shift overrides.'),
  ('attendance.master.manage',     'attendance', 'Manage attendance policies, shift assignments, weekly-off configuration, shift overrides.'),
  ('attendance.import.view',       'attendance', 'View import batches and their rows.'),
  ('attendance.import.manage',     'attendance', 'Upload, preview, commit, and roll back attendance imports.'),
  ('attendance.record.view',       'attendance', 'View any employee''s attendance records.'),
  ('attendance.record.manage',     'attendance', 'Manually create or edit attendance records outside the correction workflow (HR-only, exceptional use).'),
  ('attendance.correction.request','attendance', 'Request a correction to one''s own attendance record.'),
  ('attendance.correction.approve','attendance', 'Approve or reject attendance correction requests at any configured level.'),
  ('attendance.lock.manage',       'attendance', 'Lock, unlock, and re-lock attendance periods.'),
  ('attendance.report.view',       'attendance', 'View attendance reports (daily, monthly register, late/early/overtime/absent, summary).')
on conflict (permission_code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_ADMIN' and p.module = 'attendance'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_VIEWER' and p.module = 'attendance' and p.permission_code like '%.view'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'EMPLOYEE' and p.permission_code = 'attendance.correction.request'
on conflict do nothing;

-- attendance.correction.approve is deliberately also granted to the
-- EMPLOYEE baseline role, not just HR_ADMIN — a reporting manager
-- approving their own team's correction requests is an ordinary
-- employee, not necessarily an HR_ADMIN. This permission is only the
-- coarse "can attempt to approve something" gate; the real per-request
-- authorization is isEntitledApprover() in lib/approvals.ts, checked
-- inside the route AFTER this permission passes — it verifies the
-- caller is specifically the resolved reporting manager (or role
-- holder) for THIS request's current level, not just "an employee."
-- Granting this broadly and relying on the entitlement check for the
-- real restriction is the same pattern permission frameworks call
-- "coarse gate + fine-grained authorization," applied here rather
-- than trying to model "is someone's manager" as a role.
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'EMPLOYEE' and p.permission_code = 'attendance.correction.approve'
on conflict do nothing;
