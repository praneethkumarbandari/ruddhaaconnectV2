-- ============================================================
-- REAL PF/ESI STATUTORY RATES
-- ============================================================
-- The statutory-rules calculation engine (Stage 11 of
-- calculatePayrollLine(), src/lib/payroll-calculation.ts) was
-- already fully built and already actually called on every payroll
-- run -- this isn't dead code. But zero rows existed in
-- statutory_rules, so it had nothing to calculate: every payroll run
-- silently produced zero PF/ESI deduction, not because the engine is
-- broken, but because nobody had configured what to calculate.
--
-- Rates below are the real, standard Indian statutory rates as of
-- this system's design. Rates DO change by government notification
-- (most recently ESI's employer share, historically PF ceiling) --
-- these are correct as seeded, but whoever operates this system is
-- responsible for updating them if the government changes them,
-- the same way they'd update any other configured rate. This
-- migration does not claim to auto-track future rate changes.
--
-- All employer_share rows post to whichever account
-- payroll_account_mappings has configured for
-- EMPLOYER_CONTRIBUTION_EXPENSE / EMPLOYER_CONTRIBUTION_PAYABLE (see
-- PAYROLL_ACCOUNTING_INTEGRATION.md) -- no new account mapping
-- needed, this only adds the RATES that mapping already expects to
-- exist somewhere.
-- ============================================================

-- FIX: distinct from wage_ceiling. wage_ceiling caps the amount a
-- rate is calculated against (PF: 12% on at most Rs.15,000 of basic,
-- even if actual basic is higher). eligibility_ceiling answers a
-- different question -- whether the rule applies AT ALL. Without
-- this column, ESI (which has no wage_ceiling at all, since its rate
-- applies to the full gross once eligible) would have been
-- calculated for every employee regardless of wage, including those
-- earning well above the real Rs.21,000 eligibility line.
alter table statutory_rules add column if not exists eligibility_ceiling numeric(12,2);

insert into statutory_rules
  (rule_code, rule_name, calculation_type, wage_basis, rate, wage_ceiling, eligibility_ceiling, employee_share_percentage, employer_share_percentage, is_active, effective_from)
values
  -- Provident Fund: 12% of Basic (or Basic+DA), both employee and
  -- employer contribute 12% each, capped at a wage ceiling of
  -- Rs.15,000/month for statutory-minimum PF (an employer can choose
  -- to contribute on full basic instead, which is a configuration
  -- change to this same row, not a code change). No eligibility
  -- ceiling -- PF applies at every wage level, just capped at
  -- Rs.15,000 for the calculation itself.
  ('PF_EMPLOYEE', 'Provident Fund (Employee Share)', 'percentage', 'basic', 12.000, 15000.00, null, 100.00, 0.00, true, current_date),
  ('PF_EMPLOYER', 'Provident Fund (Employer Share)', 'percentage', 'basic', 12.000, 15000.00, null, 0.00, 100.00, true, current_date),

  -- ESI: only applicable to employees whose gross wage is at or below
  -- Rs.21,000/month -- that's eligibility_ceiling here, correctly
  -- distinct from wage_ceiling (which stays null, since once
  -- eligible, ESI's rate applies to the FULL gross with no cap).
  ('ESI_EMPLOYEE', 'ESI (Employee Share)', 'percentage', 'gross', 0.750, null, 21000.00, 100.00, 0.00, true, current_date),
  ('ESI_EMPLOYER', 'ESI (Employer Share)', 'percentage', 'gross', 3.250, null, 21000.00, 0.00, 100.00, true, current_date)
on conflict (rule_code) do nothing;
