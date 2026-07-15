-- ================================================================
-- schema-customer-portal.sql
--
-- Fixes a critical, previously-undocumented auth flow: the customer
-- portal (customer-login.html / customer-dashboard.html / etc.) was
-- authenticating directly against Supabase from the browser, storing
-- and comparing PLAINTEXT passwords, and never had a migration file
-- for the columns it depends on (email, password, otp_code,
-- otp_expiry were created by hand directly in Supabase — the same
-- pattern that caused the silent Bank & Cash and Customer Requests
-- bugs documented in schema-legacy-modules.sql).
--
-- This migration is additive only, per the frozen-table rule: the
-- `customers` table already exists (schema-phase2.sql) and is used
-- by accounting (sales_invoices.customer_id, receipts, etc.) — none
-- of that is touched here.
--
-- Column notes:
--   email          - login identifier. Unique (case-insensitive) so
--                    two customers can never collide on login.
--   password_hash  - bcrypt hash ONLY. The old `password` column (if
--                    it exists from prior hand-created Supabase
--                    schema) held plaintext and is never read or
--                    written by the new backend routes. It is left
--                    in place (not dropped) so this migration cannot
--                    destroy data on a live deployment; it should be
--                    dropped manually once every customer has a real
--                    password_hash and the old plaintext column is
--                    confirmed unused.
--   otp_hash       - bcrypt hash of the current password-reset OTP.
--                    The OTP itself is never stored in the database.
--   otp_expiry     - OTP validity window (10 minutes, enforced by the
--                    backend, not the client).
-- ================================================================

alter table customers
  add column if not exists email         text,
  add column if not exists password_hash text,
  add column if not exists otp_hash      text,
  add column if not exists otp_expiry    timestamptz;

-- Case-insensitive uniqueness on email, but only where email is set —
-- existing rows created before this migration (e.g. business-only
-- customers with no portal login) are untouched.
create unique index if not exists customers_email_unique
  on customers (lower(email))
  where email is not null;
