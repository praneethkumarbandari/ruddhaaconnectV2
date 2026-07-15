-- FIX: schema-tds.sql's own comment claimed these were "real, current
-- rates" — they weren't, verified against the actual Finance Act 2024
-- / 2025 changes for FY 2025-26:
--
--   194H (Commission/Brokerage): was seeded at 5.00% / ₹15,000 —
--   actually 2% (cut from 5%, effective 1 Oct 2024) with a ₹20,000
--   threshold (raised from ₹15,000, effective 1 Apr 2025). Simple
--   update, no structural change needed.
--
--   194J (Professional/Technical Services): was seeded as one flat
--   10.00% / ₹30,000 row. Actually two different rates depending on
--   the nature of the service — 10% for professional services, 2%
--   for technical services — both now at a ₹50,000 threshold (raised
--   from ₹30,000, effective 1 Apr 2025). The single-row seed
--   structurally couldn't represent this at all, not just a wrong
--   number — same class of problem the existing 194I split
--   (194I_RENT_LAND / 194I_RENT_PLANT) already solved for rent.
--   Split the same way.
--
--   194C (Payment to Contractors): was seeded as one flat 1.00% row.
--   Actually 1% for individual/HUF payees, 2% for company/firm/other
--   payees — a genuine, long-standing rate difference by deductee
--   type, not a recent change, that the single-row seed also
--   structurally couldn't represent. Split the same way.
--
-- Under-deducting TDS creates real, non-trivial exposure: interest
-- under Section 201(1A), and expense disallowance under Section
-- 40(a)(ia) at assessment — this isn't cosmetic data drift.
--
-- Every application code path reads tds_sections dynamically (no
-- section code is ever hardcoded anywhere in lib/ or routes/), so
-- splitting these into more specific rows is safe — verified by
-- searching the whole codebase for hardcoded '194C'/'194J' references
-- before writing this migration, not assumed.

-- FIX: found running this for real — tds_sections didn't exist on
-- this database at all (schema-tds.sql, much earlier in the migrate
-- chain, was apparently never actually run here). This fix depended
-- on that table already existing. Made self-sufficient: creates the
-- table and its original seed data first (both idempotent — safe
-- even if schema-tds.sql WAS already run elsewhere), then applies
-- the same rate corrections as before.

create table if not exists tds_sections (
  id                        bigserial primary key,
  section_code              text        not null unique,
  section_name              text        not null,
  rate_percentage           numeric(5,2) not null,
  threshold_single_payment  numeric(12,2),
  threshold_aggregate_annual numeric(12,2),
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

update tds_sections set rate_percentage = 2.00, threshold_single_payment = 20000.00
  where section_code = '194H';

update tds_sections set
  section_code = '194J_PROFESSIONAL',
  section_name = 'Professional Services',
  rate_percentage = 10.00,
  threshold_single_payment = 50000.00
  where section_code = '194J';

insert into tds_sections (section_code, section_name, rate_percentage, threshold_single_payment, threshold_aggregate_annual)
values ('194J_TECHNICAL', 'Technical Services', 2.00, 50000.00, null)
on conflict (section_code) do nothing;

update tds_sections set
  section_code = '194C_INDIVIDUAL',
  section_name = 'Payment to Contractors — Individual/HUF',
  rate_percentage = 1.00
  where section_code = '194C';

insert into tds_sections (section_code, section_name, rate_percentage, threshold_single_payment, threshold_aggregate_annual)
values ('194C_COMPANY', 'Payment to Contractors — Company/Firm/Other', 2.00, 30000.00, 100000.00)
on conflict (section_code) do nothing;
