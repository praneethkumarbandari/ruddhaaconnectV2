-- ============================================================
-- ACCOUNTING PERIOD LOCKING (in addition to Financial Year close)
-- ============================================================
-- FIX (real gap): status ('open'/'closed'/'archived') only locks a
-- financial year as a WHOLE. There was no way to lock everything
-- through, say, the quarter you've already filed a GST return for,
-- while leaving the rest of the still-open financial year postable —
-- a routine real-world need (auditors reviewing Q1, GST return
-- already filed for a period, month-end close before year-end close),
-- not an edge case.
--
-- locked_through_date is null by default (no interim lock — whole-
-- year status is the only gate, unchanged behavior for every existing
-- financial year). When set, any entry dated on or before this date
-- is rejected exactly like a closed financial year would reject it —
-- see requireOpenFinancialYear() in lib/fy.ts — even though the
-- financial year's own status is still 'open'.
alter table financial_years add column if not exists locked_through_date date;

-- A lock date must fall inside the year it's locking, and can't lock
-- the ENTIRE year that way (that's what status='closed' is for) —
-- prevents a confusing state where locked_through_date silently
-- exceeds end_date and does nothing, or equals it and duplicates the
-- whole-year close.
alter table financial_years drop constraint if exists financial_years_lock_within_year;
alter table financial_years add constraint financial_years_lock_within_year
  check (locked_through_date is null or (locked_through_date >= start_date and locked_through_date < end_date));
