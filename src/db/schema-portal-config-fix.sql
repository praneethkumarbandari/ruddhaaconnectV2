-- ============================================================
-- PORTAL_CONFIG — additive fix
-- ============================================================
-- portal_config was never tracked in any migration file in this
-- repo — it exists (if at all) only because someone created it
-- directly in Supabase at some point, outside version control.
-- That's exactly why Settings could not save company details or
-- the newer account-mapping fields: the columns the frontend
-- code sends may never have existed on the real table at all.
--
-- Every single column below is taken directly from the actual,
-- working application code (content/settings.html, js/shell.js) —
-- not guessed. This is written to be safe to run regardless of
-- the table's current state:
--   - If portal_config doesn't exist yet, it's created complete.
--   - If it already exists with only some columns, every column
--     it's missing gets added; nothing existing is touched,
--     dropped, or renamed, so no data is at risk either way.
-- ============================================================

create table if not exists portal_config (
  id                bigserial primary key,
  created_at        timestamptz not null default now()
);

-- Branding / theme (read by js/shell.js on every page load)
alter table portal_config add column if not exists company_name        text;
alter table portal_config add column if not exists logo_path           text;
alter table portal_config add column if not exists primary_color       text;
alter table portal_config add column if not exists secondary_color     text;
alter table portal_config add column if not exists background_color   text;
alter table portal_config add column if not exists font_family         text;

-- Business & Branding section of Settings
alter table portal_config add column if not exists address             text;
alter table portal_config add column if not exists company_state       text;
alter table portal_config add column if not exists gst_number          text;
alter table portal_config add column if not exists support_phone       text;
alter table portal_config add column if not exists support_email       text;
alter table portal_config add column if not exists website             text;
alter table portal_config add column if not exists currency            text default 'INR';

-- Account Mapping — core fields (already expected to exist per the
-- frontend's own fallback logic)
alter table portal_config add column if not exists debtors_account_code   text;
alter table portal_config add column if not exists creditors_account_code text;
alter table portal_config add column if not exists sales_account_code     text;
alter table portal_config add column if not exists purchases_account_code text;
alter table portal_config add column if not exists gst_output_account_code text;
alter table portal_config add column if not exists gst_input_account_code  text;

-- Account Mapping — expansion fields (this is the exact set the
-- frontend was already coded to expect from a file named
-- account_mappings_expansion.sql, which never actually existed
-- anywhere in this repo — this migration is that missing file,
-- named and organized here instead).
alter table portal_config add column if not exists discount_allowed_account_code  text;
alter table portal_config add column if not exists discount_received_account_code text;
alter table portal_config add column if not exists freight_account_code           text;
alter table portal_config add column if not exists tds_payable_account_code       text;
alter table portal_config add column if not exists tds_receivable_account_code    text;
alter table portal_config add column if not exists tcs_account_code              text;
alter table portal_config add column if not exists cash_account_code             text;
alter table portal_config add column if not exists round_off_account_code        text;
alter table portal_config add column if not exists opening_balance_account_code  text;
alter table portal_config add column if not exists inventory_adjustment_account_code text;
alter table portal_config add column if not exists salary_payable_account_code   text;

comment on table portal_config is 'Single-row (in practice) portal-wide configuration: branding, theme, and default GL account mappings used by Settings. Every column here is directly derived from the real frontend code that reads/writes it — see content/settings.html and js/shell.js.';
