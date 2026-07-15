-- ============================================================
-- RUDDHAA ERP — HR MODULE, MILESTONE 5: PAYROLL ENGINE
--
-- Additive only. Depends on schema.sql (chart_of_accounts,
-- postJournalEntry's tables), schema-permissions.sql,
-- schema-hr-masters.sql (salary_components, salary_structures,
-- salary_structure_components, cost_centers), schema-hr-employee-master.sql,
-- schema-attendance.sql, and schema-leave.sql all having run.
--
-- ACCOUNTING PRINCIPLE, restated because this milestone is the one
-- most likely to be tempted to violate it: nothing in this file, or
-- in lib/payroll-accounting.ts, ever inserts into journal_entries or
-- journal_entry_lines directly. Every posting goes through the
-- existing postJournalEntry() (src/lib/posting-engine.ts) — the same
-- single posting gate Sales, Purchase, Receipts, and Payments already
-- use. The only Accounting-side change this milestone makes is
-- additive and documented in full in PAYROLL_ACCOUNTING_INTEGRATION.md.
--
-- SCOPE NOTE — what's NOT duplicated:
-- - `salary_components`, `salary_structures`, `salary_structure_components`
--   (Milestone 1) are reused as-is. This file does not redefine them.
-- - `attendance_records`, `leave_balance_transactions`,
--   `leave_requests` (Milestones 3-4) are READ by the calculation
--   pipeline, never written to by Payroll, and never duplicated —
--   Payroll has no working-days/paid-days/LOP columns of its own;
--   every payroll line's attendance/leave figures are computed by
--   querying those tables at calculation time (see
--   lib/payroll-calculation.ts's "Attendance Resolution" and "Leave
--   Resolution" stages) and then SNAPSHOTTED into payroll_lines
--   (immutable once locked) — the same "derive at calculation time,
--   then snapshot for immutable history" pattern already used for
--   attendance_records' department/branch/cost_center columns.
-- ============================================================

-- ------------------------------------------------------------
-- SALARY STRUCTURE VERSIONING — "never overwrite, use versioning" is
-- satisfied by TWO mechanisms together, not a new "structure version"
-- table:
-- 1. This table (date-ranged employee-to-structure assignment,
--    mirroring employee_shift_assignments' exact EXCLUDE-constraint
--    pattern) — which structure applied to which employee, when.
-- 2. payroll_line_components below (a point-in-time snapshot of the
--    actual resolved amount used) — what was actually calculated and
--    paid, immune to any LATER edit of salary_structure_components.
-- Editing salary_structures/salary_structure_components (Milestone 1)
-- going forward only ever affects FUTURE payroll runs — every past
-- run's payroll_line_components rows are untouched, because they
-- never referenced the live components table's current values, only
-- a snapshot of them at calculation time.
-- ------------------------------------------------------------
create table employee_salary_structure_assignments (
  id              bigserial   primary key,
  employee_id     bigint      not null references employees(id),
  structure_id    bigint      not null references salary_structures(id),
  effective_from  date        not null,
  effective_to    date,
  created_by      bigint      references employees(id),
  created_at      timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create index idx_salary_assignments_employee on employee_salary_structure_assignments(employee_id, effective_from);
alter table employee_salary_structure_assignments add constraint excl_salary_assignment_overlap
  exclude using gist (
    employee_id with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
  );

-- ------------------------------------------------------------
-- STATUTORY FRAMEWORK — configurable, not hardcoded to any country.
-- calculation_type drives which of the nullable fields below apply:
--   'percentage' -> rate + wage_ceiling
--   'fixed'      -> fixed_amount
--   'slab'       -> statutory_rule_slabs (progressive, e.g. income tax)
-- employee_share_percentage/employer_share_percentage split a single
-- computed base amount between the two — e.g. PF is commonly 12%
-- employee + 12% employer on the SAME wage base, modeled as one rule
-- with both shares, not two separate rules, so "this is one
-- statutory scheme with two sides" is explicit in the data rather
-- than implied by naming convention.
-- ------------------------------------------------------------
create table statutory_rules (
  id                        bigserial     primary key,
  rule_code                 text          not null unique,
  rule_name                 text          not null,
  calculation_type          text          not null check (calculation_type in ('percentage', 'fixed', 'slab')),
  wage_basis                text          not null default 'basic' check (wage_basis in ('basic', 'gross')),
  rate                      numeric(6,3),
  fixed_amount              numeric(12,2),
  wage_ceiling              numeric(12,2),
  employee_share_percentage numeric(5,2)  not null default 100.00,
  employer_share_percentage numeric(5,2)  not null default 0.00,
  is_active                 boolean       not null default true,
  effective_from            date          not null default current_date,
  created_at                timestamptz   not null default now(),
  updated_at                timestamptz   not null default now(),
  check (
    (calculation_type = 'percentage' and rate is not null) or
    (calculation_type = 'fixed' and fixed_amount is not null) or
    (calculation_type = 'slab')
  )
);

create table statutory_rule_slabs (
  id               bigserial    primary key,
  statutory_rule_id bigint      not null references statutory_rules(id) on delete cascade,
  slab_from        numeric(12,2) not null,
  slab_to          numeric(12,2),  -- null = no upper bound (top slab)
  rate             numeric(6,3)  not null,
  created_at       timestamptz  not null default now(),
  unique (statutory_rule_id, slab_from)
);
create index idx_statutory_slabs_rule on statutory_rule_slabs(statutory_rule_id);

-- ------------------------------------------------------------
-- ACCOUNT MAPPING LAYER — the configurable posting-target catalog
-- this milestone introduces. Not a duplicate of anything: Sales and
-- Purchase (pre-existing) hardcode their posting account codes as
-- TypeScript constants (see lib/sales.ts's OUTPUT_CGST etc.) — this
-- is the first configurable, data-driven account-mapping mechanism in
-- the codebase, built because the spec explicitly requires it for
-- Payroll, not retrofitted onto Sales/Purchase (out of scope; see
-- PAYROLL_ACCOUNTING_INTEGRATION.md for why that's a separate,
-- future, cross-module decision, not something this migration does).
--
-- mapping_key is a fixed, small catalog of POSTING ROLES the
-- calculation pipeline knows how to use structurally (below) — not
-- one row per salary component. component_id, when set, overrides
-- the default mapping for that one specific component (e.g. "HRA"
-- posts to a different expense account than "Basic Pay" even though
-- both are mapping_key='SALARY_EXPENSE"); when null, the row is the
-- fallback default for every component of the relevant type that has
-- no specific override. statutory_rule_id works the same way for
-- rules instead of components.
-- ------------------------------------------------------------
create table payroll_account_mappings (
  id                 bigserial   primary key,
  mapping_key        text        not null check (mapping_key in (
                        'SALARY_EXPENSE', 'EMPLOYER_CONTRIBUTION_EXPENSE',
                        'EMPLOYEE_DEDUCTION_PAYABLE', 'EMPLOYER_CONTRIBUTION_PAYABLE',
                        'NET_SALARY_PAYABLE', 'LOAN_RECEIVABLE',
                        'REIMBURSEMENT_EXPENSE', 'REIMBURSEMENT_PAYABLE', 'BANK_ACCOUNT'
                      )),
  component_id       bigint      references salary_components(id),
  statutory_rule_id  bigint      references statutory_rules(id),
  account_code       text        not null references chart_of_accounts(account_code),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (component_id is null or statutory_rule_id is null),  -- a row overrides one or the other, never both
  unique (mapping_key, component_id, statutory_rule_id)
);
create index idx_payroll_mapping_key on payroll_account_mappings(mapping_key);

-- ------------------------------------------------------------
-- LOANS & ADVANCES — one table, `loan_type` discriminates, per the
-- same "simplest structure matching an actual requirement" reasoning
-- used throughout this codebase (Attendance Manual Entry vs.
-- Correction, employee_master.status as an enum, etc.). A salary
-- advance is, structurally, a short loan — same recovery mechanism,
-- same ledger, no reason for a second table.
-- ------------------------------------------------------------
create table employee_loans (
  id                  bigserial   primary key,
  employee_id         bigint      not null references employees(id),
  loan_type           text        not null check (loan_type in ('loan', 'advance')),
  principal_amount    numeric(12,2) not null check (principal_amount > 0),
  interest_rate       numeric(5,2) not null default 0,
  emi_amount          numeric(12,2) not null check (emi_amount > 0),
  number_of_installments int      not null check (number_of_installments > 0),
  disbursed_date      date        not null,
  status              text        not null default 'active' check (status in ('active', 'closed', 'settled')),
  created_by          bigint      references employees(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index idx_loans_employee on employee_loans(employee_id);
create index idx_loans_status on employee_loans(status);

create table loan_installments (
  id                  bigserial   primary key,
  loan_id             bigint      not null references employee_loans(id),
  installment_number  int         not null,
  due_period           text        not null,  -- 'YYYY-MM', the payroll period this installment is due in
  emi_amount          numeric(12,2) not null,
  principal_component numeric(12,2) not null,
  interest_component  numeric(12,2) not null default 0,
  status              text        not null default 'pending' check (status in ('pending', 'recovered', 'waived')),
  payroll_line_id     bigint,     -- set when actually recovered through a payroll run (FK added below, after payroll_lines exists)
  recovered_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (loan_id, installment_number)
);
create index idx_installments_loan on loan_installments(loan_id);
create index idx_installments_status on loan_installments(status);
create index idx_installments_due_period on loan_installments(due_period) where status = 'pending';

-- ------------------------------------------------------------
-- REIMBURSEMENTS — reuses the generic approval framework exactly like
-- Attendance Corrections and Leave Requests. "Approvals" per the spec
-- is this same lib/approvals.ts engine, not a third bespoke workflow.
-- ------------------------------------------------------------
create table reimbursement_claims (
  id              bigserial   primary key,
  employee_id     bigint      not null references employees(id),
  claim_type      text        not null,
  amount          numeric(12,2) not null check (amount > 0),
  is_taxable      boolean     not null default false,
  claim_date      date        not null,
  description     text,
  status          text        not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paid')),
  current_level_order int     not null default 1,
  requested_by    bigint      not null references employees(id),
  decided_by      bigint      references employees(id),
  decided_at      timestamptz,
  decision_notes  text,
  payroll_line_id bigint,     -- FK added below, after payroll_lines exists
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index idx_reimbursements_employee on reimbursement_claims(employee_id);
create index idx_reimbursements_status on reimbursement_claims(status);

insert into approval_hierarchies (hierarchy_code, module, description) values
  ('HR_REIMBURSEMENT_APPROVAL', 'hr', 'Reimbursement claim: reporting manager, then HR sign-off.')
on conflict (hierarchy_code) do nothing;

insert into approval_hierarchy_levels (hierarchy_id, level_order, approver_type, approver_role_id, description)
select h.id, 1, 'reporting_manager', null, 'Requester''s reporting manager'
from approval_hierarchies h where h.hierarchy_code = 'HR_REIMBURSEMENT_APPROVAL'
on conflict (hierarchy_id, level_order) do nothing;

insert into approval_hierarchy_levels (hierarchy_id, level_order, approver_type, approver_role_id, description)
select h.id, 2, 'role', r.id, 'HR sign-off'
from approval_hierarchies h, roles r
where h.hierarchy_code = 'HR_REIMBURSEMENT_APPROVAL' and r.role_code = 'HR_ADMIN'
on conflict (hierarchy_id, level_order) do nothing;

-- ------------------------------------------------------------
-- PAYROLL RUNS — one row per processing run. status is the run's own
-- lock, not a row in attendance_locks (a payroll run's lifecycle —
-- draft/processed/locked/posted/reopened — is richer than a simple
-- boolean lock and belongs to the run itself).
-- ------------------------------------------------------------
create table payroll_runs (
  id                        bigserial   primary key,
  run_type                  text        not null check (run_type in ('monthly', 'off_cycle', 'final_settlement', 'arrears')),
  period_start              date        not null,
  period_end                date        not null,
  status                    text        not null default 'draft'
                              check (status in ('draft', 'processed', 'locked', 'posted', 'reopened')),
  branch_id                 bigint      references branches(id),  -- nullable: null = whole-company run
  processed_by              bigint      references employees(id),
  processed_at              timestamptz,
  locked_by                 bigint      references employees(id),
  locked_at                 timestamptz,
  reopened_by               bigint      references employees(id),
  reopened_at               timestamptz,
  reopen_reason             text,
  accrual_journal_entry_id  bigint      references journal_entries(id),
  payment_journal_entry_id  bigint      references journal_entries(id),
  posted_by                 bigint      references employees(id),
  posted_at                 timestamptz,
  created_at                timestamptz not null default now(),
  check (period_end >= period_start)
);
create index idx_payroll_runs_period on payroll_runs(period_start, period_end);
create index idx_payroll_runs_status on payroll_runs(status);

-- ------------------------------------------------------------
-- PAYROLL LINES — one row per employee per run. Freely recomputed
-- (deleted + reinserted) while the run is 'draft' or 'processed'
-- ("Reprocessing before lock"); immutable once the run reaches
-- 'locked' — enforced in lib/payroll-calculation.ts, the same
-- discipline attendance_locks enforces for attendance writes, applied
-- here to the run's own status instead of a separate lock table.
-- ------------------------------------------------------------
create table payroll_lines (
  id                    bigserial     primary key,
  payroll_run_id        bigint        not null references payroll_runs(id),
  employee_id           bigint        not null references employees(id),
  salary_structure_id   bigint        references salary_structures(id),
  working_days          numeric(5,1)  not null default 0,
  paid_days             numeric(5,1)  not null default 0,
  lop_days              numeric(5,1)  not null default 0,
  overtime_hours        numeric(6,2)  not null default 0,
  overtime_amount       numeric(12,2) not null default 0,
  gross_earnings        numeric(12,2) not null default 0,
  gross_deductions      numeric(12,2) not null default 0,
  loan_recovery_amount  numeric(12,2) not null default 0,
  reimbursement_amount  numeric(12,2) not null default 0,
  net_salary            numeric(12,2) not null default 0,
  department_id         bigint       references departments(id),
  branch_id              bigint      references branches(id),
  cost_center_id         bigint      references cost_centers(id),
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  unique (payroll_run_id, employee_id)
);
create index idx_payroll_lines_run on payroll_lines(payroll_run_id);
create index idx_payroll_lines_employee on payroll_lines(employee_id);
create index idx_payroll_lines_department on payroll_lines(department_id);
create index idx_payroll_lines_cost_center on payroll_lines(cost_center_id);

-- Now that payroll_lines exists, wire the two forward-references
-- declared as bare columns above (same "declare the column, add the
-- FK once the target exists" pattern schema-attendance.sql /
-- schema-leave.sql already used for attendance_records.leave_request_id).
alter table loan_installments add constraint fk_installments_payroll_line
  foreign key (payroll_line_id) references payroll_lines(id);
alter table reimbursement_claims add constraint fk_reimbursements_payroll_line
  foreign key (payroll_line_id) references payroll_lines(id);
create index idx_installments_payroll_line on loan_installments(payroll_line_id) where payroll_line_id is not null;
create index idx_reimbursements_payroll_line on reimbursement_claims(payroll_line_id) where payroll_line_id is not null;

-- ------------------------------------------------------------
-- PAYROLL LINE COMPONENTS — the point-in-time snapshot that makes
-- "never overwrite, use versioning" real (see the header note on
-- employee_salary_structure_assignments above). One row per
-- component (earning or deduction) that actually contributed to one
-- employee's one payroll run, with the RESOLVED amount — never a
-- live reference back to salary_structure_components' current value.
-- ------------------------------------------------------------
create table payroll_line_components (
  id               bigserial     primary key,
  payroll_line_id  bigint        not null references payroll_lines(id) on delete cascade,
  component_id     bigint        references salary_components(id),        -- null for a statutory-rule-only line (see statutory_rule_id)
  statutory_rule_id bigint       references statutory_rules(id),
  component_type   text          not null check (component_type in ('earning', 'deduction', 'employer_contribution')),
  amount           numeric(12,2) not null,
  created_at       timestamptz   not null default now(),
  check (component_id is not null or statutory_rule_id is not null)
);
create index idx_payroll_line_components_line on payroll_line_components(payroll_line_id);

-- ============================================================
-- Permissions.
-- ============================================================
insert into permissions (permission_code, module, description) values
  ('payroll.view',    'payroll', 'View payroll runs, lines, and payslips.'),
  ('payroll.process', 'payroll', 'Create and reprocess payroll runs before lock.'),
  ('payroll.lock',    'payroll', 'Lock a payroll run.'),
  ('payroll.unlock',  'payroll', 'Re-open a locked payroll run.'),
  ('payroll.post',    'payroll', 'Post a locked payroll run to Accounting.'),
  ('payroll.manage',  'payroll', 'Manage salary structure assignments, statutory rules, account mappings, loans, and reimbursements administratively.'),
  ('payroll.approve', 'payroll', 'Approve or reject reimbursement claims.'),
  ('payroll.reimbursement.claim', 'payroll', 'Submit a reimbursement claim for oneself.')
on conflict (permission_code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_ADMIN' and p.module = 'payroll'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'HR_VIEWER' and p.permission_code = 'payroll.view'
on conflict do nothing;

-- Same coarse-permission + fine-grained-entitlement pattern as
-- attendance corrections and leave: every employee can submit a
-- reimbursement claim and can attempt to approve one (isEntitledApprover
-- does the real per-request restriction).
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'EMPLOYEE' and p.permission_code in ('payroll.reimbursement.claim', 'payroll.approve')
on conflict do nothing;
