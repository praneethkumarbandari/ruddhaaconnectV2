-- ============================================================
-- INVOICE ENGINE — additive fields
-- ============================================================
-- Fields the new Create Invoice page needs that don't exist on the
-- live tables yet. Everything below is a nullable, additive column —
-- safe to run regardless of current data, nothing existing is
-- touched, dropped, or renamed.
-- ============================================================

-- Due Date — sales_invoices and purchase_invoices both need it for
-- the Create Invoice page's Due Date field.
alter table sales_invoices add column if not exists due_date date;
alter table purchase_invoices add column if not exists due_date date;

-- Customers and vendors currently only have name/gstin/supply_type —
-- no contact or address fields at all. The Create Invoice page (and
-- the Customers/Vendors master pages) need these to show real party
-- details when a party is selected.
alter table customers add column if not exists email text;
alter table customers add column if not exists phone text;
alter table customers add column if not exists address_line1 text;
alter table customers add column if not exists address_line2 text;
alter table customers add column if not exists city text;
alter table customers add column if not exists state text;
alter table customers add column if not exists pincode text;

alter table vendors add column if not exists email text;
alter table vendors add column if not exists phone text;
alter table vendors add column if not exists address_line1 text;
alter table vendors add column if not exists address_line2 text;
alter table vendors add column if not exists city text;
alter table vendors add column if not exists state text;
alter table vendors add column if not exists pincode text;

-- NOTE: supply_type ('intrastate'/'interstate') remains the actual,
-- authoritative source for the CGST+SGST vs IGST decision on
-- invoices — it already exists and is already correct. The new
-- `state` column above is for display/address purposes only (showing
-- the party's state on the invoice form), not a second, competing way
-- to decide the tax split. A reference version of this page compared
-- state names as strings instead of using supply_type directly — that
-- approach is NOT used here, since supply_type is more direct and
-- doesn't depend on state names being spelled/cased consistently.
