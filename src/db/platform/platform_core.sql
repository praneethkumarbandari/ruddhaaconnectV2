-- ================================================================
-- RUDDHAA PLATFORM CORE
-- ================================================================
-- Runs against its OWN, separate control-plane database — never the
-- same database as any tenant's master_schema.sql. This is the one
-- deliberate deviation from "append to master_schema.sql" (see the
-- accompanying review for why): every table below is a singular,
-- platform-wide concept (one registry of companies, not one per
-- company), and concatenating it into the per-tenant script would
-- give every tenant database its own disconnected copy of what must
-- be a single source of truth.
--
-- Zero foreign keys reach into any tenant database — physically
-- impossible in Postgres across separate databases, and architecturally
-- correct regardless: Platform Core knows *that* a company exists and
-- *where* its data lives, never the content of that data.
-- ================================================================

-- ================================================================
-- COMPANIES — the tenant registry itself
-- ================================================================
create table companies (
  id                 bigserial primary key,
  company_code       text        not null unique,
  company_name       text        not null,
  -- A non-secret pointer to the tenant's actual database — an alias,
  -- environment-variable name, or connection identifier your
  -- deployment tooling resolves, NOT a raw connection string with a
  -- password in it. Real credentials belong in a secrets manager, not
  -- a queryable table.
  database_reference text        not null unique,
  is_active          boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index idx_companies_is_active on companies(is_active);

-- ================================================================
-- COMPANY SETTINGS — branding + regional + business preferences,
-- deliberately ONE table, not three. All three (branding, regional,
-- business preferences) share the same 1:1 cardinality with companies
-- and the same read pattern (fetched together whenever rendering a
-- tenant's portal) — splitting them would be three tables solving one
-- problem. Structured columns, not a jsonb blob, for the same reason
-- the rest of this platform prefers typed columns with real
-- constraints over free-form data wherever the shape is well-known.
-- ================================================================
create table company_settings (
  company_id        bigint      primary key references companies(id),
  -- Branding
  logo_url          text,
  favicon_url       text,
  primary_color     text,
  secondary_color   text,
  font_family       text,
  -- Regional / business preferences
  currency_code     text        not null default 'INR',
  country_code      text        not null default 'IN',
  timezone          text        not null default 'Asia/Kolkata',
  language_code     text        not null default 'en',
  fiscal_year_start_month int    not null default 4 check (fiscal_year_start_month between 1 and 12),
  updated_at        timestamptz not null default now()
);

-- ================================================================
-- MODULES — the platform's registry of what modules exist at all,
-- independent of which companies use them. One row per module ever
-- built (Accounting, Project Management, HR, Bank Import, and future
-- Inventory/CRM/Manufacturing/Costing/Lucky each get exactly one row
-- here, added when they're actually built — not pre-created now).
-- ================================================================
create table modules (
  id           bigserial primary key,
  module_code  text        not null unique,
  module_name  text        not null,
  description  text,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now()
);

-- ================================================================
-- PLANS — billing tiers. Deliberately NOT bundled to specific modules
-- via a plan_modules junction table: module access is tracked
-- independently in company_modules below, since a real SaaS billing
-- model commonly needs add-on modules beyond a company's base plan.
-- Rejected as unneeded complexity until evidence says otherwise.
-- ================================================================
create table plans (
  id             bigserial primary key,
  plan_code      text        not null unique,
  plan_name      text        not null,
  billing_cycle  text        not null check (billing_cycle in ('monthly','annual')),
  price          numeric(12,2) not null default 0,
  description    text,
  is_active      boolean     not null default true,
  created_at     timestamptz not null default now()
);

-- ================================================================
-- SUBSCRIPTIONS — one company's actual billing relationship.
-- "licenses" (mentioned as an example in the brief) was considered
-- and rejected as redundant: nothing in the stated requirements needs
-- per-seat/per-user license counting distinct from this table.
-- ================================================================
create table subscriptions (
  id                 bigserial primary key,
  company_id         bigint      not null references companies(id),
  plan_id            bigint      not null references plans(id),
  status             text        not null default 'trial'
                        check (status in ('trial','active','past_due','cancelled','expired')),
  start_date         date        not null,
  current_period_end date        not null,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index idx_subscriptions_company on subscriptions(company_id);
create index idx_subscriptions_status on subscriptions(status);

-- ================================================================
-- COMPANY MODULES — actual per-company module enablement. This is
-- where "trial module," "purchased module," "module status," and
-- "feature flags" all genuinely live — feature_overrides is jsonb
-- specifically because per-company feature toggles are inherently
-- free-form and don't have their own lifecycle independent of this
-- row (failed the "does this deserve its own table" test on purpose).
-- ================================================================
create table company_modules (
  id                 bigserial primary key,
  company_id         bigint      not null references companies(id),
  module_id          bigint      not null references modules(id),
  status             text        not null default 'trial'
                        check (status in ('trial','active','disabled')),
  version            text,
  enabled_at         timestamptz not null default now(),
  expires_at         timestamptz,
  feature_overrides  jsonb,
  unique (company_id, module_id)
);
create index idx_company_modules_company on company_modules(company_id);

-- ================================================================
-- TENANT LOGIN DIRECTORY — authentication routing ONLY. Stores no
-- password hash, no role, nothing that duplicates a tenant's own
-- employees table — just enough to answer "given this login
-- identifier, which company's database should the real auth check
-- run against?" before that database connection is even made.
-- ================================================================
create table tenant_login_directory (
  id                bigserial primary key,
  login_identifier  text        not null,
  company_id        bigint      not null references companies(id),
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  -- Deliberately (login_identifier, company_id), not login_identifier
  -- alone: one person can legitimately work across multiple companies
  -- (a consultant serving three separate client businesses on
  -- Ruddhaa), each with their own tenant employee record. A single
  -- global unique-per-email constraint would make that scenario
  -- impossible to represent at all — proven by reproducing the exact
  -- failure against the original constraint before this fix, then
  -- confirming this constraint both allows the legitimate multi-company
  -- case and still rejects a true duplicate (same email, same company).
  unique (login_identifier, company_id)
);
-- No separate index on login_identifier alone: the composite unique
-- index above already serves an equality lookup on just its leading
-- column efficiently (standard btree behavior). A company_id-only
-- index IS still needed, though — company_id is the *trailing*
-- column in that composite index, which a leading-column-only lookup
-- cannot use efficiently at real scale (needed for admin/suspension
-- workflows: "list every directory entry for this company").
create index idx_tenant_login_directory_company on tenant_login_directory(company_id);

-- ================================================================
-- COMMENTS
-- ================================================================
comment on table companies is 'The tenant registry. One row per business using Ruddhaa. database_reference points at (never contains) the tenant''s actual database credentials.';
comment on table company_settings is 'Branding + regional + business preferences, deliberately consolidated into one 1:1 table rather than split by concern.';
comment on table modules is 'Platform-wide module registry — one row per module ever built, not per company.';
comment on table plans is 'Billing tiers. Does not bundle specific modules — see company_modules for actual per-company access.';
comment on table subscriptions is 'A company''s billing relationship to a plan.';
comment on table company_modules is 'Actual per-company module enablement, including trial/feature-flag state.';
comment on table tenant_login_directory is 'Authentication routing only — resolves a login identifier to a company before any tenant database connection is made. Stores no credentials.';
