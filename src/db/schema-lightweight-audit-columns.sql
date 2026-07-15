-- ============================================================
-- LIGHTWEIGHT AUDIT COLUMNS ON MASTERS
-- ============================================================
-- The centralized audit_log table remains the complete, detailed
-- history (full old/new value snapshots, every action, every module) —
-- this does NOT replace it. What audit_log doesn't give you cheaply is
-- "who created/last touched this row, and when" for a list or form
-- view without a join out to audit_log per row. These columns are
-- exactly that: a fast, denormalized read of the same facts audit_log
-- already records in detail.
--
-- Scoped to the core Accounting masters only (customers, vendors,
-- chart_of_accounts, bank_accounts) — this round's review was
-- explicitly the remaining Accounting module, not a schema-wide sweep
-- across HR/payroll/CRM/etc.

alter table customers add column if not exists created_by bigint references employees(id);
alter table customers add column if not exists updated_by bigint references employees(id);
alter table customers add column if not exists updated_at timestamptz not null default now();

alter table vendors add column if not exists created_by bigint references employees(id);
alter table vendors add column if not exists updated_by bigint references employees(id);
alter table vendors add column if not exists updated_at timestamptz not null default now();

alter table chart_of_accounts add column if not exists created_by bigint references employees(id);
alter table chart_of_accounts add column if not exists updated_by bigint references employees(id);
-- chart_of_accounts already has updated_at (schema.sql) — nothing to add there.

-- bank_accounts already has created_at/updated_at (schema-legacy-modules.sql) — only created_by/updated_by are missing.
alter table bank_accounts add column if not exists created_by bigint references employees(id);
alter table bank_accounts add column if not exists updated_by bigint references employees(id);
