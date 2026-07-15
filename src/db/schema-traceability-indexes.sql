-- ================================================================
-- schema-traceability-indexes.sql
--
-- Adds indexes on journal_entry_id across the six voucher tables that
-- link back to journal_entries. These are demonstrably queried, not a
-- speculative guess: test/phase2-regression.ts explicitly checks "every
-- posted/cancelled sales invoice's journal_entry_id resolves" (and the
-- same for purchase invoices, receipts, payments, credit/debit notes),
-- and reconciliation/reporting flows join through this column.
--
-- Deliberately NOT adding indexes to the other ~60 unindexed FK columns
-- found during the production-readiness re-audit (mostly audit-trail
-- columns like created_by/decided_by/approved_by, rarely filtered on
-- directly) -- doing that without real query-pattern data would be a
-- guess, and every index has a real write-throughput cost. This is the
-- one category with clear, demonstrated read traffic.
-- ================================================================

create index if not exists idx_sales_invoices_journal_entry on sales_invoices(journal_entry_id);
create index if not exists idx_purchase_invoices_journal_entry on purchase_invoices(journal_entry_id);
create index if not exists idx_receipts_journal_entry on receipts(journal_entry_id);
create index if not exists idx_payments_journal_entry on payments(journal_entry_id);
create index if not exists idx_credit_notes_journal_entry on credit_notes(journal_entry_id);
create index if not exists idx_debit_notes_journal_entry on debit_notes(journal_entry_id);
