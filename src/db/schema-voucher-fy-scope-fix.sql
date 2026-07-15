-- ================================================================
-- schema-voucher-fy-scope-fix.sql
--
-- CRITICAL FIX, same class as schema-je-no-financial-year-scope-fix.sql:
-- sales_invoices.invoice_no, purchase_invoices.purchase_no,
-- receipts.receipt_no, payments.payment_no, credit_notes.credit_note_no,
-- and debit_notes.debit_note_no all had a GLOBAL `unique` constraint,
-- while their numbers (via nextDocumentNumber()) are financial-year-
-- scoped by design — every FY's counter restarts at 1 for every
-- document type. Live-reproduced: posting the first sales invoice of
-- one financial year, then the first of a second, always collides on
-- "INV-0001" already existing, once a real deployment crosses into a
-- second fiscal year.
--
-- Unlike journal_entries, none of these six tables had a
-- financial_year_id column at all, so this migration:
--   1. adds the column (nullable at first, so this is safe on a
--      table that may already have rows),
--   2. backfills it for any existing rows by matching each row's own
--      date column against financial_years' date range,
--   3. drops the old bare unique constraint,
--   4. adds the correct composite (number, financial_year_id) unique
--      constraint.
--
-- Rows whose date doesn't fall inside any known financial year are
-- left with financial_year_id = null after backfill (same as a fresh
-- draft row that hasn't been posted/numbered yet) rather than
-- guessed at — a null financial_year_id with a null number (draft,
-- unposted) is unaffected by the unique constraint either way, since
-- Postgres treats any row with a null in a unique constraint's
-- columns as automatically distinct from every other row.
-- ================================================================

alter table sales_invoices add column if not exists financial_year_id bigint references financial_years(id);
update sales_invoices si set financial_year_id = fy.id
  from financial_years fy
  where si.financial_year_id is null and si.invoice_date between fy.start_date and fy.end_date;
alter table sales_invoices drop constraint if exists sales_invoices_invoice_no_key;
alter table sales_invoices add constraint sales_invoices_invoice_no_fy_unique unique (invoice_no, financial_year_id);

alter table purchase_invoices add column if not exists financial_year_id bigint references financial_years(id);
update purchase_invoices pi set financial_year_id = fy.id
  from financial_years fy
  where pi.financial_year_id is null and pi.invoice_date between fy.start_date and fy.end_date;
alter table purchase_invoices drop constraint if exists purchase_invoices_purchase_no_key;
alter table purchase_invoices add constraint purchase_invoices_purchase_no_fy_unique unique (purchase_no, financial_year_id);

alter table receipts add column if not exists financial_year_id bigint references financial_years(id);
update receipts r set financial_year_id = fy.id
  from financial_years fy
  where r.financial_year_id is null and r.receipt_date between fy.start_date and fy.end_date;
alter table receipts drop constraint if exists receipts_receipt_no_key;
alter table receipts add constraint receipts_receipt_no_fy_unique unique (receipt_no, financial_year_id);

alter table payments add column if not exists financial_year_id bigint references financial_years(id);
update payments p set financial_year_id = fy.id
  from financial_years fy
  where p.financial_year_id is null and p.payment_date between fy.start_date and fy.end_date;
alter table payments drop constraint if exists payments_payment_no_key;
alter table payments add constraint payments_payment_no_fy_unique unique (payment_no, financial_year_id);

alter table credit_notes add column if not exists financial_year_id bigint references financial_years(id);
update credit_notes cn set financial_year_id = fy.id
  from financial_years fy
  where cn.financial_year_id is null and cn.note_date between fy.start_date and fy.end_date;
alter table credit_notes drop constraint if exists credit_notes_credit_note_no_key;
alter table credit_notes add constraint credit_notes_note_no_fy_unique unique (credit_note_no, financial_year_id);

alter table debit_notes add column if not exists financial_year_id bigint references financial_years(id);
update debit_notes dn set financial_year_id = fy.id
  from financial_years fy
  where dn.financial_year_id is null and dn.note_date between fy.start_date and fy.end_date;
alter table debit_notes drop constraint if exists debit_notes_debit_note_no_key;
alter table debit_notes add constraint debit_notes_note_no_fy_unique unique (debit_note_no, financial_year_id);
