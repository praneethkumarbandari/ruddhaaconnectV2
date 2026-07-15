-- ============================================================
-- INVOICE LINE HSN + ITEM LINKAGE
-- ============================================================
-- sales_invoice_lines and purchase_invoice_lines had no HSN code and
-- no link back to the inventory item a line came from -- only a
-- free-text description. This made an HSN-wise summary (a real,
-- required part of GSTR-1) structurally impossible to generate, not
-- just unformatted: there was no HSN data anywhere to summarize.
--
-- Both columns are nullable and additive. item_id is set-null on
-- delete (an inventory item being removed later should never be able
-- to retroactively break a historical invoice line) and does not
-- require every line to reference a real item -- a manually-typed
-- line (no inventory item selected) still has no HSN, honestly,
-- rather than a guessed one.
-- ============================================================

alter table sales_invoice_lines add column if not exists hsn text;
alter table sales_invoice_lines add column if not exists item_id bigint references inventory(id) on delete set null;

alter table purchase_invoice_lines add column if not exists hsn text;
alter table purchase_invoice_lines add column if not exists item_id bigint references inventory(id) on delete set null;

-- ============================================================
-- HONEST LIMITATION, stated plainly: this only fixes lines created
-- AFTER this migration and the accompanying backend/frontend changes
-- are deployed. Every existing invoice line has no HSN and no item
-- link, and this migration cannot retroactively know what item a
-- historical free-text description referred to -- that would be a
-- guess, not a fact, and this migration does not guess. An HSN-wise
-- summary report run over a date range that includes pre-fix
-- invoices will show those lines' HSN as blank/unknown, honestly,
-- not silently omitted or wrongly inferred.
-- ============================================================
