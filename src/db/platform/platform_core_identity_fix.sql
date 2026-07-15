-- ================================================================
-- PLATFORM CORE — identity architecture fix (delta only)
-- ================================================================
-- Fixes tenant_login_directory's uniqueness constraint to support one
-- login identifier legitimately belonging to multiple companies (the
-- consultant-across-three-clients scenario) — reproduced and proven
-- against a real database before writing this fix:
--
--   BEFORE: unique(login_identifier) alone rejected a second company
--   mapping for the same email with:
--     "duplicate key value violates unique constraint
--      tenant_login_directory_login_identifier_key"
--
--   AFTER: unique(login_identifier, company_id) allows the same email
--   to map to multiple companies, while still correctly rejecting a
--   true duplicate (same email, same company) — also proven.
--
-- Apply this only if platform_core.sql was already run once. A fresh
-- install should use the corrected platform_core.sql directly instead
-- (it now creates the table with this constraint from the start).
-- ================================================================

alter table tenant_login_directory
  drop constraint tenant_login_directory_login_identifier_key;

alter table tenant_login_directory
  add constraint tenant_login_directory_login_identifier_company_id_key
  unique (login_identifier, company_id);

-- The company_id index this table already had is unaffected and
-- remains necessary (it's the trailing column in the new composite
-- constraint, which doesn't serve company-only lookups efficiently).
-- No other index change is required.
