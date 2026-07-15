-- ============================================================
-- RUDDHAA ERP — HR MODULE, MILESTONE 4: LEAVE MANAGEMENT
--
-- Additive only. Depends on schema.sql, schema-permissions.sql,
-- schema-hr-masters.sql (leave_types, holidays, document_types),
-- schema-hr-employee-master.sql, and schema-attendance.sql
-- (attendance_records, attendance_locks, attendance_statuses) all
-- having run.
--
-- SCOPE NOTE — masters explicitly NOT duplicated:
-- - "Leave Types" already exists in full (schema-hr-masters.sql):
--   leave_type_code/name, accrual_frequency, default_annual_days,
--   allow_carry_forward, max_carry_forward_days, allow_encashment.
--   This milestone extends leave TYPES' behavior via a new 1:1
--   `leave_policies` table (below) rather than re-defining or
--   altering that table — same "extend via a linked table" pattern
--   Milestone 3 used for shifts -> attendance_policies.
-- - "Holiday Inclusion Rules" reuses Milestone 1's `holidays` table
--   directly (no new holiday concept) — a policy column
--   (`count_holidays_as_leave`) controls whether a holiday inside an
--   applied leave range counts against balance; the holiday data
--   itself is not duplicated.
-- - "Weekly Off Rules" reuses Milestone 3's `weekly_off_configurations`
--   directly, same reasoning.
-- - Accrual Rules, Carry Forward Rules, Encashment Rules, Sandwich
--   Leave Rules, Half-Day Rules, Probation Leave Rules, and Notice
--   Period Rules are ALL consolidated into `leave_policies` as
--   columns, not seven separate one-row-per-policy tables — the same
--   consolidation reasoning already applied to
--   `attendance_policies` (grace/late/early/overtime rules) and
--   `employee_master.status` (a fixed enum, not a lookup table):
--   these are facets of one policy configuration per leave type, not
--   independent entities with their own lifecycle.
-- ============================================================

-- ------------------------------------------------------------
-- LEAVE POLICIES — one row per leave type, extending Milestone 1's
-- leave_types with the deeper rule set this milestone adds.
-- ------------------------------------------------------------
create table leave_policies (
  id                          bigserial     primary key,
  leave_type_id               bigint        not null unique references leave_types(id),
  requires_balance_check      boolean       not null default true,
  -- false for a type like "Loss of Pay" — unlimited by definition,
  -- never blocked by insufficient balance. A dedicated boolean rather
  -- than a sentinel balance value (e.g. -1 = unlimited), since a
  -- sentinel would have to be defended against everywhere balance is
  -- summed or displayed.
  half_day_enabled            boolean       not null default true,
  max_consecutive_days        numeric(5,1),
  -- Sandwich rule: a weekly-off/holiday strictly BETWEEN two leave
  -- days within the SAME request (e.g. Fri+Mon leave bridging a
  -- Sat/Sun weekly-off) is counted as leave too when enabled — see
  -- lib/leave.ts's calculateLeaveDayCount() for the exact algorithm
  -- and its documented scope boundary (only within one request's
  -- range; does not look at other requests or prior approved leave).
  sandwich_rule_enabled       boolean       not null default false,
  count_holidays_as_leave     boolean       not null default false,
  -- Probation: employees within N days of joining_date may be
  -- disallowed (or allowed) to use this leave type at all. 0 = no
  -- probation restriction.
  probation_period_days       int           not null default 0,
  allow_during_probation      boolean       not null default true,
  -- Notice period: employees with exit_date already set (serving
  -- notice) may be restricted from applying for this leave type.
  notice_period_restricted    boolean       not null default false,
  -- Carry-forward expiry: carried-forward days lapse N months into
  -- the new leave year if unused. Null = never expires beyond
  -- leave_types.max_carry_forward_days' own cap at the point of
  -- carrying forward.
  carry_forward_expiry_months int,
  encashment_rate             numeric(5,2)  not null default 1.00,
  max_encashable_days         numeric(5,1),
  is_active                   boolean       not null default true,
  created_at                  timestamptz   not null default now(),
  updated_at                  timestamptz   not null default now(),
  check (max_consecutive_days is null or max_consecutive_days > 0)
);

-- ------------------------------------------------------------
-- LEAVE YEAR CONFIGURATION — a company-wide setting for when the
-- annual leave cycle starts (calendar Jan-Dec, fiscal Apr-Mar, or
-- any other month). Deliberately NOT modeled like financial_years
-- (which has explicit start_date/end_date rows per year) — a leave
-- year is an annually-repeating month/day, not a bounded record per
-- year, so a single small config row is the simplest fit. Exactly
-- one row should be active at a time; enforced by convention
-- (application code always upserts the single active row) rather
-- than a partial unique index, since this table is expected to be
-- touched extremely rarely (once, at setup) and over-engineering its
-- uniqueness guarantee isn't worth it for a single-admin-editable
-- setting.
-- ------------------------------------------------------------
create table leave_year_configurations (
  id           bigserial   primary key,
  start_month  int         not null check (start_month between 1 and 12),
  start_day    int         not null default 1 check (start_day between 1 and 28),
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
insert into leave_year_configurations (start_month, start_day)
select 1, 1
where not exists (select 1 from leave_year_configurations);

-- ------------------------------------------------------------
-- LEAVE BALANCE LEDGER — the balance-tracking design this milestone
-- explicitly required ("never overwrite historical balances,"
-- "maintain complete audit history"). This is a LEDGER, not a mutable
-- "current balance" row — deliberately mirroring this codebase's own
-- accounting philosophy (journal_entries as the single source of
-- truth, balances always derived by summing, never stored and
-- overwritten). A closing balance for
-- (employee, leave_type, leave_year) is `sum(days)` over this table;
-- opening balance, accrual, carry-forward, encashment, expiry, and
-- manual adjustment are all just rows with a signed `days` value and
-- a `transaction_type` tag — one shape, six meanings, exactly like
-- journal_entries is one shape for every kind of accounting event.
-- ------------------------------------------------------------
create table leave_balance_transactions (
  id               bigserial   primary key,
  employee_id      bigint      not null references employees(id),
  leave_type_id    bigint      not null references leave_types(id),
  leave_year       int         not null,  -- the calendar year the leave-year period STARTS in
  transaction_type text        not null check (transaction_type in (
                     'opening_balance', 'accrual', 'consumption', 'carry_forward',
                     'encashment', 'expiry', 'manual_adjustment'
                   )),
  days             numeric(6,2) not null,  -- positive = credit to balance, negative = debit
  reference_type   text        check (reference_type in ('leave_request', 'manual', 'system')),
  reference_id     bigint,     -- leave_requests.id when reference_type = 'leave_request'; no FK (see below)
  remarks          text,
  created_by       bigint      references employees(id),
  created_at       timestamptz not null default now(),
  check (transaction_type <> 'consumption' or days <= 0),
  check (transaction_type not in ('opening_balance','accrual','carry_forward') or days >= 0)
);
create index idx_leave_balance_employee_type_year on leave_balance_transactions(employee_id, leave_type_id, leave_year);
create index idx_leave_balance_reference on leave_balance_transactions(reference_type, reference_id) where reference_id is not null;
-- reference_id intentionally has no FK: it points at leave_requests.id
-- only when reference_type = 'leave_request', and at nothing in
-- particular for 'manual'/'system' — a polymorphic reference, same
-- reasoning bank_import_rows already applies to its own optional
-- draft_receipt_id/draft_payment_id (except there, two separate
-- nullable FK columns were used because there were only ever two
-- possible targets; here, restricting to a single real FK target
-- table keeps this simpler without losing any real integrity
-- guarantee this table needs).

-- ------------------------------------------------------------
-- LEAVE REQUESTS
-- ------------------------------------------------------------
create table leave_requests (
  id                  bigserial   primary key,
  employee_id         bigint      not null references employees(id),
  leave_type_id       bigint      not null references leave_types(id),
  from_date           date        not null,
  to_date             date        not null,
  is_half_day         boolean     not null default false,
  half_day_session    text        check (half_day_session in ('first_half', 'second_half')),
  day_count           numeric(5,1) not null,  -- computed at application time; see lib/leave.ts calculateLeaveDayCount()
  reason              text        not null,
  status              text        not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  current_level_order int         not null default 1,
  requested_by        bigint      not null references employees(id),
  decided_by          bigint      references employees(id),
  decided_at          timestamptz,
  decision_notes      text,
  cancelled_by        bigint      references employees(id),
  cancelled_at        timestamptz,
  cancellation_reason text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (to_date >= from_date),
  check (not is_half_day or from_date = to_date),
  check (is_half_day = (half_day_session is not null))
);
create index idx_leave_requests_employee on leave_requests(employee_id);
create index idx_leave_requests_status on leave_requests(status);
create index idx_leave_requests_dates on leave_requests(from_date, to_date);

-- Now that leave_requests exists, wire attendance_records' pointer
-- to it (declared as a bare column in schema-attendance.sql, since
-- this table didn't exist yet when that file runs first).
alter table attendance_records add constraint fk_attendance_records_leave_request
  foreign key (leave_request_id) references leave_requests(id);
create index idx_attendance_records_leave_request on attendance_records(leave_request_id) where leave_request_id is not null;

-- Domain Review carry-forward (Milestone 3 review, TD-22): prevents
-- two simultaneously-pending correction requests for the same
-- employee+date. Leave has the identical race (an employee
-- resubmitting a leave request for overlapping dates before the first
-- is decided) — applying the same fix here from the start rather than
-- waiting to discover it again.
create unique index idx_leave_requests_one_pending_per_employee_date_range on leave_requests(employee_id, from_date, to_date) where status = 'pending';

-- ------------------------------------------------------------
-- Approval hierarchy: reuses the generic engine (lib/approvals.ts)
-- exactly as attendance corrections do. "HR Approval (if configured)"
-- is, again, just whether a second level row exists.
-- ------------------------------------------------------------
insert into approval_hierarchies (hierarchy_code, module, description) values
  ('HR_LEAVE_APPROVAL', 'hr', 'Leave request: reporting manager, then HR sign-off.')
on conflict (hierarchy_code) do nothing;

insert into approval_hierarchy_levels (hierarchy_id, level_order, approver_type, approver_role_id, description)
select h.id, 1, 'reporting_manager', null, 'Requester''s reporting manager'
from approval_hierarchies h where h.hierarchy_code = 'HR_LEAVE_APPROVAL'
on conflict (hierarchy_id, level_order) do nothing;

insert into approval_hierarchy_levels (hierarchy_id, level_order, approver_type, approver_role_id, description)
select h.id, 2, 'role', r.id, 'HR sign-off'
from approval_hierarchies h, roles r
where h.hierarchy_code = 'HR_LEAVE_APPROVAL' and r.role_code = 'HR_ADMIN'
on conflict (hierarchy_id, level_order) do nothing;

-- ------------------------------------------------------------
-- Attendance integration: a new status code approved leave writes
-- into attendance_records via the same lookup-by-code pattern
-- established in Milestone 3 (never a hardcoded ID).
-- ------------------------------------------------------------
insert into attendance_statuses (status_code, status_name, is_paid) values
  ('ON_LEAVE', 'On Leave', true)
on conflict (status_code) do nothing;
-- Note: is_paid = true here is a default, not a universal truth —
-- Loss of Pay leave is modeled as its own leave_type with
-- leave_policies.requires_balance_check = false, not as ON_LEAVE
-- with is_paid = false, because payability for LOP is a per-employee,
-- per-request fact (how many days they had no balance for), not a
-- fixed property of "the ON_LEAVE status" the way HOLIDAY or
-- WEEKLY_OFF's paid status is fixed. See PAYROLL_READINESS_ASSESSMENT.md
-- (Milestone 4 addendum) for how Payroll should actually determine
-- LOP days: by leave_type, not by attendance status alone.

-- ============================================================
-- Permissions. leave.type.* is deliberately NOT created — Milestone
-- 1's hr.leave_type.view/hr.leave_type.manage already own that
-- resource in full; this milestone's masters (leave_policies,
-- leave_year_configurations) get their own leave.policy.* codes
-- since they're a genuinely new resource, not a duplicate of leave_types.
-- ============================================================
insert into permissions (permission_code, module, description) values
  ('leave.policy.view',    'leave', 'View leave policies and leave year configuration.'),
  ('leave.policy.manage',  'leave', 'Create/update leave policies and leave year configuration.'),
  ('leave.apply',          'leave', 'Apply for and cancel one''s own leave.'),
  ('leave.approve',        'leave', 'Approve or reject leave requests at any configured level.'),
  ('leave.view',           'leave', 'View any employee''s leave requests and history.'),
  ('leave.manage',         'leave', 'HR-level administrative actions on leave requests.'),
  ('leave.balance.view',   'leave', 'View any employee''s leave balance.'),
  ('leave.balance.adjust', 'leave', 'Post opening balances, accrual, carry-forward, encashment, and manual balance adjustments.'),
  ('leave.report.view',    'leave', 'View leave reports.')
on conflict (permission_code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_ADMIN' and p.module = 'leave'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_VIEWER' and p.module = 'leave' and p.permission_code like '%.view'
on conflict do nothing;

-- Same coarse-permission + fine-grained-entitlement pattern Milestone
-- 3's attendance corrections established: every employee can apply
-- for their own leave and can attempt to approve (the real
-- restriction is isEntitledApprover() checking they're the actual
-- resolved approver for a specific request).
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'EMPLOYEE' and p.permission_code in ('leave.apply', 'leave.approve')
on conflict do nothing;
