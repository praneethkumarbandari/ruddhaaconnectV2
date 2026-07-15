-- ------------------------------------------------------------
-- Bank Import Engine schema (Accounting V1.1)
--
-- Architectural note: nothing in this file references
-- journal_entries or journal_entry_lines directly, and no table
-- here is ever written to by the posting engine. The only link
-- between an imported row and the accounting engine is a nullable
-- foreign key to receipts/payments — the same draft records any
-- manually-entered receipt/payment would produce. The Import Engine
-- stops at "draft created"; everything past that point (posting,
-- journal entries, ledger) is the existing engine acting on an
-- ordinary draft it can't tell apart from a manually entered one.
-- ------------------------------------------------------------

create table mapping_templates (
  id                bigserial primary key,
  template_name     text        not null,
  bank_account_code text        not null,
  -- Maps each required logical field to the source file's column
  -- header text, e.g. {"transactionDate":"Txn Date","narration":"Particulars",
  -- "debit":"Withdrawal Amt","credit":"Deposit Amt","balance":"Closing Balance",
  -- "referenceNumber":"Chq/Ref No"}. Read and written only by the
  -- import engine's mapping logic — the posting engine never touches
  -- this table.
  column_mapping    jsonb       not null,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  unique (template_name)
);

create table bank_import_batches (
  id                  bigserial primary key,
  file_name           text        not null,
  bank_account_code   text        not null,
  mapping_template_id bigint      references mapping_templates(id),
  status              text        not null default 'processing'
                        check (status in ('processing','completed','failed')),
  total_rows          int         not null default 0,
  rows_imported       int         not null default 0,  -- passed validation, not a duplicate
  rows_rejected       int         not null default 0,  -- failed validation
  rows_duplicate      int         not null default 0,  -- matched an existing imported row
  rows_draft_created  int         not null default 0,
  rows_posted         int         not null default 0,
  imported_by         bigint,
  imported_at         timestamptz not null default now()
);

create table bank_import_rows (
  id                  bigserial primary key,
  batch_id            bigint      not null references bank_import_batches(id),
  -- Denormalized from the parent batch deliberately: duplicate
  -- detection must compare across different batches/files for the
  -- same bank account, so the account code needs to be queryable
  -- directly on this table rather than joined through batch each time.
  bank_account_code   text        not null,
  row_number          int         not null,          -- 1-indexed position in the source file, for user-facing error messages
  transaction_date    date,                          -- null if the row failed to parse a valid date
  narration           text,
  debit               numeric(18,2) not null default 0,
  credit              numeric(18,2) not null default 0,
  balance             numeric(18,2),
  reference_number    text,
  status              text        not null default 'imported'
                        check (status in (
                          'imported', 'validated', 'rejected', 'duplicate',
                          'ready_for_draft', 'draft_created', 'posted'
                        )),
  rejection_reason    text,
  -- Which existing customer/vendor this row was manually matched to
  -- (never auto-matched — no AI categorisation, per scope). Required
  -- before a draft can be created.
  matched_party_type  text        check (matched_party_type in ('customer','vendor')),
  matched_party_id    bigint,
  -- Populated once a draft is created via the EXISTING receipts/payments
  -- engine (createDraftReceipt / createDraftPayment) — never written to
  -- directly by import logic, only by calling those real functions.
  draft_receipt_id    bigint      references receipts(id),
  draft_payment_id    bigint      references payments(id),
  created_at          timestamptz not null default now()
);

create index idx_bank_import_rows_batch on bank_import_rows(batch_id);
create index idx_bank_import_rows_status on bank_import_rows(status);
-- Duplicate detection: same bank account + date + amount + reference
-- appearing in a previous import is flagged, without ever needing to
-- inspect journal_entries (the import engine's duplicate check only
-- ever looks at its own queue history, not the ledger).
create index idx_bank_import_rows_dupe_check on bank_import_rows(bank_account_code, transaction_date, debit, credit, reference_number);
