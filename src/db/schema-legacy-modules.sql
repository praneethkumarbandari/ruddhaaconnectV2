-- ================================================================
-- schema-legacy-modules.sql
--
-- Proper migration SQL for tables that were previously created by
-- hand directly in Supabase, with no migration file anywhere in this
-- repository (confirmed by grepping every src/db/*.sql file before
-- writing this — none of them define these tables). This file gives
-- Inventory, Bank Accounts/Transactions, and Customer Requests a real
-- migration for the first time, using the ACTUAL column shapes their
-- frontend pages already depend on today (recovered from each page's
-- own "FIX:" comments, which document the real column names after
-- previous debugging passes corrected the frontend to match them).
--
-- `create table if not exists` throughout: if a table already exists
-- in a given deployment's Supabase project (the common case — this is
-- recovering a migration for tables that already exist informally,
-- not creating new ones), this is a no-op and does not touch existing
-- data. Nothing here drops or alters any existing table.
-- ================================================================

-- ------------------------------------------------------------
-- INVENTORY
-- ------------------------------------------------------------
create table if not exists inventory (
  id             bigserial primary key,
  code           text        not null unique,
  name           text        not null,
  category       text,
  uom            text        not null default 'nos',
  opening_qty    numeric(14,3) not null default 0,
  current_stock  numeric(14,3) not null default 0,
  min_stock      numeric(14,3) not null default 0,
  hsn            text,
  gst            numeric(5,2) not null default 0,
  purchase_rate  numeric(14,2) not null default 0,
  sale_rate      numeric(14,2) not null default 0,
  description    text,
  status         text        not null default 'Active' check (status in ('Active','Inactive')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_inventory_code on inventory(code);
create index if not exists idx_inventory_status on inventory(status);

create table if not exists inventory_transactions (
  id                bigserial primary key,
  item_id           bigint      not null references inventory(id),
  transaction_date  date        not null,
  transaction_type  text        not null check (transaction_type in ('IN','OUT')),
  qty               numeric(14,3) not null,
  balance_after     numeric(14,3) not null,
  remarks           text,
  created_by        bigint,
  created_at        timestamptz not null default now()
);
create index if not exists idx_inventory_transactions_item on inventory_transactions(item_id);
create index if not exists idx_inventory_transactions_date on inventory_transactions(transaction_date);

-- ------------------------------------------------------------
-- BANK ACCOUNTS
--
-- coa_id links to the REAL chart_of_accounts table already in
-- schema.sql — every bank account's postings flow through the real
-- posting engine using this mapping (see src/lib/bank-accounts.ts),
-- not through a separate ledger_account_code text field.
-- ------------------------------------------------------------
create table if not exists bank_accounts (
  id              bigserial primary key,
  account_type    text        not null,
  account_name    text        not null,
  opening_balance numeric(14,2) not null default 0,
  coa_id          bigint      not null references chart_of_accounts(id),
  bank_name       text,
  account_number  text,
  ifsc            text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_bank_accounts_coa on bank_accounts(coa_id);

-- bank_transactions is the RAW imported/entered transaction ledger —
-- distinct from journal_entries (the posted, double-entry result).
-- mapping_status moves Unmapped -> Mapped -> Posted as the user works
-- through them; posting a transaction creates a real journal entry
-- via the posting engine and, only then, flips this row to 'Posted'.
create table if not exists bank_transactions (
  id                bigserial primary key,
  bank_account_id   bigint      not null references bank_accounts(id),
  transaction_date  date        not null,
  description       text,
  reference_no      text,
  debit             numeric(14,2) not null default 0,
  credit            numeric(14,2) not null default 0,
  mapping_status    text        not null default 'Unmapped' check (mapping_status in ('Unmapped','Mapped','Posted')),
  mapped_to         text,       -- 'Customer:<id>:<label>' | 'Vendor:<id>:<label>' | 'Expense:<code>:<label>' | ... (parsed by the frontend exactly as before)
  posted_je_id      bigint      references journal_entries(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_bank_transactions_account on bank_transactions(bank_account_id);
create index if not exists idx_bank_transactions_date on bank_transactions(transaction_date);
create index if not exists idx_bank_transactions_status on bank_transactions(mapping_status);

-- ------------------------------------------------------------
-- CUSTOMER REQUESTS
--
-- customer_id references the REAL customers table (schema-phase2.sql)
-- which only has customer_name (no separate name/email columns) — the
-- frontend's previous "join customers(name, email)" was reaching for
-- columns that don't exist on that table; the corrected service layer
-- reads customer_name instead (see Architecture Migration Report).
-- ------------------------------------------------------------
create table if not exists customer_requests (
  id            bigserial primary key,
  customer_id   bigint      not null references customers(id),
  subject       text        not null,
  description   text,
  status        text        not null default 'Open' check (status in ('Open','In Progress','Closed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_customer_requests_customer on customer_requests(customer_id);
create index if not exists idx_customer_requests_status on customer_requests(status);

-- ------------------------------------------------------------
-- COSTING (new module, V1)
-- ------------------------------------------------------------
create table if not exists costing_records (
  id              bigserial primary key,
  sheet_name      text        not null,
  item_code       text        references inventory(code),
  project_id      bigint      references projects(id),
  material_cost   numeric(14,2) not null default 0,
  labour_cost     numeric(14,2) not null default 0,
  overhead_cost   numeric(14,2) not null default 0,
  total_cost      numeric(14,2) not null default 0,
  notes           text,
  created_by      bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_costing_records_item on costing_records(item_code);
create index if not exists idx_costing_records_project on costing_records(project_id);

-- ------------------------------------------------------------
-- CRM (new module, V1)
-- ------------------------------------------------------------
create table if not exists crm_leads (
  id                bigserial primary key,
  lead_name         text        not null,
  company           text,
  phone             text,
  email             text,
  customer_id       bigint      references customers(id),
  status            text        not null default 'new' check (status in ('new','contacted','qualified','won','lost')),
  estimated_value   numeric(14,2),
  source            text,
  notes             text,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_crm_leads_status on crm_leads(status);
create index if not exists idx_crm_leads_customer on crm_leads(customer_id);

create table if not exists crm_followups (
  id              bigserial primary key,
  lead_id         bigint      not null references crm_leads(id),
  due_date        date        not null,
  followup_type   text        not null default 'call' check (followup_type in ('call','email','meeting','other')),
  notes           text,
  status          text        not null default 'pending' check (status in ('pending','done','missed')),
  created_by      bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_crm_followups_lead on crm_followups(lead_id);
create index if not exists idx_crm_followups_status on crm_followups(status);
create index if not exists idx_crm_followups_due on crm_followups(due_date);

create table if not exists crm_activities (
  id              bigserial primary key,
  lead_id         bigint      not null references crm_leads(id),
  activity_date   date        not null,
  activity_type   text        not null default 'call' check (activity_type in ('call','email','meeting','note','other')),
  summary         text        not null,
  created_by      bigint,
  created_at      timestamptz not null default now()
);
create index if not exists idx_crm_activities_lead on crm_activities(lead_id);
create index if not exists idx_crm_activities_date on crm_activities(activity_date);
