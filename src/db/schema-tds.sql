-- ============================================================
-- TDS (TAX DEDUCTED AT SOURCE)
-- ============================================================
-- Real Indian TDS mechanics: certain vendor payments require the
-- PAYER to withhold a percentage before paying, and remit that
-- withheld amount to the government against the vendor's PAN (not
-- GSTIN — a separate identifier this system never tracked at all).
-- ============================================================

-- TDS is filed against PAN, not GSTIN. Both can exist independently
-- (a vendor can have a GSTIN with no PAN on file yet, or vice versa
-- during onboarding) — nullable, additive.
alter table vendors add column if not exists pan text;

-- Section master. Rates and thresholds are real, current, standard
-- Indian TDS section rates — same disclosure as the PF/ESI rates
-- seeded earlier: correct as seeded, but subject to government
-- notification changes over time, which whoever operates this system
-- is responsible for updating, the same as any other configured rate.
create table if not exists tds_sections (
  id                        bigserial primary key,
  section_code              text        not null unique,
  section_name              text        not null,
  rate_percentage           numeric(5,2) not null,
  threshold_single_payment  numeric(12,2),  -- no TDS if a single payment is at or below this
  threshold_aggregate_annual numeric(12,2), -- no TDS if the FY-to-date total to this vendor is at or below this
  is_active                 boolean     not null default true,
  created_at                timestamptz not null default now()
);

insert into tds_sections (section_code, section_name, rate_percentage, threshold_single_payment, threshold_aggregate_annual) values
  ('194C', 'Payment to Contractors', 1.00, 30000.00, 100000.00),
  ('194J', 'Professional / Technical Services', 10.00, 30000.00, null),
  ('194H', 'Commission or Brokerage', 5.00, 15000.00, null),
  ('194I_RENT_LAND', 'Rent — Land/Building/Furniture', 10.00, 240000.00, null),
  ('194I_RENT_PLANT', 'Rent — Plant/Machinery/Equipment', 2.00, 240000.00, null),
  ('194Q', 'Purchase of Goods', 0.10, null, 5000000.00)
on conflict (section_code) do nothing;

-- ============================================================
-- HONEST LIMITATION: rates above are for resident, PAN-furnished
-- deductees only. Real TDS law has materially different (higher)
-- rates when a deductee has NOT furnished PAN (Section 206AA — flat
-- 20% in most cases), and different rates again for non-resident
-- deductees (Section 195, treaty-dependent). Neither of those cases
-- is modeled here — this system assumes every vendor is a
-- PAN-furnished resident. If that's not true for a specific vendor,
-- the rate must be corrected manually before deducting, not assumed
-- correct by this seed data.
-- ============================================================

-- Which section, and how much, was actually deducted on a given
-- payment. amount is the payment's gross settlement value (same
-- figure payment_allocations settles against invoices, unchanged);
-- tds_amount is how much of that was withheld rather than paid in
-- cash — added here rather than computed on the fly, since a rate
-- change later must never retroactively alter what a past payment
-- actually withheld.
alter table payments add column if not exists tds_section_id bigint references tds_sections(id);
alter table payments add column if not exists tds_amount numeric(18,2) not null default 0;

-- Deduction register — the actual source of truth for Form 16A
-- (certificate to the vendor) and Form 26Q (quarterly return to the
-- government). One row per payment that had TDS applied; never
-- edited after creation, only ever superseded by a reversal if the
-- underlying payment is itself cancelled (see reverseJournalEntry()
-- — the same real reversal mechanism every other voucher type uses,
-- not a separate TDS-specific undo path).
create table if not exists tds_deductions (
  id                bigserial primary key,
  payment_id        bigint      not null references payments(id),
  vendor_id         bigint      not null references vendors(id),
  tds_section_id    bigint      not null references tds_sections(id),
  gross_amount      numeric(18,2) not null,
  tds_rate          numeric(5,2)  not null,  -- the rate actually applied, copied at deduction time — see note above
  tds_amount        numeric(18,2) not null,
  deduction_date    date        not null,
  financial_year_id bigint      not null references financial_years(id),
  quarter           int         not null check (quarter between 1 and 4),
  created_at        timestamptz not null default now()
);
create index idx_tds_deductions_vendor on tds_deductions(vendor_id);
create index idx_tds_deductions_fy_quarter on tds_deductions(financial_year_id, quarter);
