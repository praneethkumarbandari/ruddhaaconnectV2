-- ============================================================
-- RUDDHAA ERP — PHASE 2: ACCOUNTING MODULE
-- Additive only. No Phase 1 table (chart_of_accounts,
-- financial_years, journal_entries, journal_entry_lines,
-- numbering_sequences, audit_log, employees) is altered here.
-- Every posting in this phase flows through the existing
-- lib/posting-engine.ts postJournalEntry() — nothing here writes
-- to journal_entries / journal_entry_lines directly.
-- ============================================================

-- ------------------------------------------------------------
-- GST ACCOUNTS — needed before any GST posting can happen.
-- Additive rows into the existing chart_of_accounts table.
-- ------------------------------------------------------------
insert into chart_of_accounts (account_code, account_name, account_type, is_system) values
  ('2151', 'Output CGST', 'liability', true),
  ('2152', 'Output SGST', 'liability', true),
  ('2153', 'Output IGST', 'liability', true),
  ('1161', 'Input CGST',  'asset',     true),
  ('1162', 'Input SGST',  'asset',     true),
  ('1163', 'Input IGST',  'asset',     true)
on conflict (account_code) do nothing;

-- ------------------------------------------------------------
-- CUSTOMERS / VENDORS
-- Never deleted, only deactivated — same rule as chart_of_accounts.
-- ------------------------------------------------------------
create table customers (
  id            bigserial primary key,
  customer_name text        not null,
  gstin         text,
  supply_type   text        not null default 'intrastate' check (supply_type in ('intrastate','interstate')),
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now()
);

create table vendors (
  id            bigserial primary key,
  vendor_name   text        not null,
  gstin         text,
  supply_type   text        not null default 'intrastate' check (supply_type in ('intrastate','interstate')),
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- SALES INVOICES
-- Lifecycle: draft -> posted -> cancelled (reversed).
-- Draft rows never touch the posting engine — only posting a
-- draft calls postJournalEntry(). journal_entry_id is null until
-- posted, and is the link back to the ledger once it is.
-- ------------------------------------------------------------
create table sales_invoices (
  id                bigserial primary key,
  invoice_no        text        unique,           -- assigned only at posting time, per Phase 1's numbering convention
  customer_id       bigint      not null references customers(id),
  invoice_date      date        not null,
  subtotal          numeric(18,2) not null,
  gst_amount        numeric(18,2) not null default 0,
  total             numeric(18,2) not null,
  status            text        not null default 'draft' check (status in ('draft','posted','cancelled')),
  journal_entry_id  bigint      references journal_entries(id),
  narration         text,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  posted_at         timestamptz
);

create table sales_invoice_lines (
  id                bigserial primary key,
  sales_invoice_id  bigint      not null references sales_invoices(id) on delete cascade,
  description       text        not null,
  qty               numeric(18,3) not null default 1,
  rate              numeric(18,2) not null,
  gst_rate          numeric(5,2)  not null default 0,
  line_amount       numeric(18,2) not null,   -- qty * rate, pre-GST
  line_no           integer     not null
);

create index idx_si_customer on sales_invoices(customer_id);
create index idx_si_status   on sales_invoices(status);
create index idx_sil_invoice on sales_invoice_lines(sales_invoice_id);

-- ------------------------------------------------------------
-- PURCHASE INVOICES — mirror of sales, vendor side.
-- ------------------------------------------------------------
create table purchase_invoices (
  id                bigserial primary key,
  purchase_no       text        unique,
  vendor_id         bigint      not null references vendors(id),
  invoice_date      date        not null,
  vendor_invoice_no text,                        -- the vendor's own invoice number, for reference only
  subtotal          numeric(18,2) not null,
  gst_amount        numeric(18,2) not null default 0,
  total             numeric(18,2) not null,
  status            text        not null default 'draft' check (status in ('draft','posted','cancelled')),
  journal_entry_id  bigint      references journal_entries(id),
  narration         text,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  posted_at         timestamptz
);

create table purchase_invoice_lines (
  id                  bigserial primary key,
  purchase_invoice_id bigint      not null references purchase_invoices(id) on delete cascade,
  description         text        not null,
  qty                 numeric(18,3) not null default 1,
  rate                numeric(18,2) not null,
  gst_rate            numeric(5,2)  not null default 0,
  line_amount         numeric(18,2) not null,
  line_no             integer     not null
);

create index idx_pi_vendor on purchase_invoices(vendor_id);
create index idx_pi_status on purchase_invoices(status);
create index idx_pil_invoice on purchase_invoice_lines(purchase_invoice_id);

-- ------------------------------------------------------------
-- RECEIPTS (customer money in) and their invoice allocations.
-- One receipt can allocate across multiple invoices; any
-- unallocated portion is an advance (allocation table simply has
-- fewer rows than the receipt amount covers — no separate
-- "advance" flag needed, it's just unallocated remainder).
-- ------------------------------------------------------------
create table receipts (
  id                bigserial primary key,
  receipt_no        text        unique,
  customer_id       bigint      not null references customers(id),
  receipt_date      date        not null,
  amount            numeric(18,2) not null check (amount > 0),
  bank_account_code text        not null,        -- which cash/bank account received it
  status            text        not null default 'draft' check (status in ('draft','posted','cancelled')),
  journal_entry_id  bigint      references journal_entries(id),
  narration         text,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  posted_at         timestamptz
);

create table receipt_allocations (
  id                bigserial primary key,
  receipt_id        bigint      not null references receipts(id) on delete cascade,
  sales_invoice_id  bigint      not null references sales_invoices(id),
  allocated_amount  numeric(18,2) not null check (allocated_amount > 0)
);

create index idx_receipt_customer on receipts(customer_id);
create index idx_ra_receipt on receipt_allocations(receipt_id);
create index idx_ra_invoice on receipt_allocations(sales_invoice_id);

-- ------------------------------------------------------------
-- PAYMENTS (vendor money out) — mirror of receipts.
-- ------------------------------------------------------------
create table payments (
  id                bigserial primary key,
  payment_no        text        unique,
  vendor_id         bigint      not null references vendors(id),
  payment_date      date        not null,
  amount            numeric(18,2) not null check (amount > 0),
  bank_account_code text        not null,
  status            text        not null default 'draft' check (status in ('draft','posted','cancelled')),
  journal_entry_id  bigint      references journal_entries(id),
  narration         text,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  posted_at         timestamptz
);

create table payment_allocations (
  id                  bigserial primary key,
  payment_id          bigint      not null references payments(id) on delete cascade,
  purchase_invoice_id bigint      not null references purchase_invoices(id),
  allocated_amount    numeric(18,2) not null check (allocated_amount > 0)
);

create index idx_payment_vendor on payments(vendor_id);
create index idx_pa_payment on payment_allocations(payment_id);
create index idx_pa_invoice on payment_allocations(purchase_invoice_id);

-- ------------------------------------------------------------
-- CREDIT NOTES (reduces a customer's outstanding — sales return,
-- price correction, etc.) and DEBIT NOTES (reduces a vendor's
-- outstanding). Simpler than invoices: single amount + GST, no
-- line-item grid, since correcting an existing posted invoice is
-- the use case, not a new sale.
-- ------------------------------------------------------------
create table credit_notes (
  id                bigserial primary key,
  credit_note_no    text        unique,
  customer_id       bigint      not null references customers(id),
  against_invoice_id bigint     references sales_invoices(id),
  note_date         date        not null,
  subtotal          numeric(18,2) not null,
  gst_amount        numeric(18,2) not null default 0,
  total             numeric(18,2) not null,
  status            text        not null default 'draft' check (status in ('draft','posted','cancelled')),
  journal_entry_id  bigint      references journal_entries(id),
  narration         text,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  posted_at         timestamptz
);

create table debit_notes (
  id                bigserial primary key,
  debit_note_no     text        unique,
  vendor_id         bigint      not null references vendors(id),
  against_invoice_id bigint     references purchase_invoices(id),
  note_date         date        not null,
  subtotal          numeric(18,2) not null,
  gst_amount        numeric(18,2) not null default 0,
  total             numeric(18,2) not null,
  status            text        not null default 'draft' check (status in ('draft','posted','cancelled')),
  journal_entry_id  bigint      references journal_entries(id),
  narration         text,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  posted_at         timestamptz
);

create index idx_cn_customer on credit_notes(customer_id);
create index idx_dn_vendor on debit_notes(vendor_id);
