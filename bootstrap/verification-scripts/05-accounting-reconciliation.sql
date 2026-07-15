-- Accounting Reconciliation Verification
-- Run against the live database after 04-payroll-processing.sh completes.
-- Replace :run_id with the actual payroll run id from that script.
-- Usage: psql "$DATABASE_URL" -v run_id=<id> -f 05-accounting-reconciliation.sql

-- 1. Identify the two journal entries created for this run
\echo '== Journal entries for this payroll run =='
select
  je.id,
  je.je_no,
  je.entry_date,
  je.source_type,
  je.status,
  count(jel.id) as line_count,
  sum(jel.debit) as total_debit,
  sum(jel.credit) as total_credit,
  sum(jel.debit) - sum(jel.credit) as imbalance -- must be 0
from journal_entries je
join journal_entry_lines jel on jel.journal_entry_id = je.id
where je.source_type = 'payroll'
  and je.source_id = :run_id
group by je.id, je.je_no, je.entry_date, je.source_type, je.status
order by je.id;

-- 2. Verify double-entry balance for every journal entry in the DB (not just this run)
\echo '== Balance check — expect zero rows (any row here is a corrupt entry) =='
select je.id, je.je_no, sum(jel.debit) - sum(jel.credit) as imbalance
from journal_entries je
join journal_entry_lines jel on jel.journal_entry_id = je.id
group by je.id, je.je_no
having abs(sum(jel.debit) - sum(jel.credit)) > 0.01;

-- 3. Full journal entry line breakdown for this run
\echo '== Journal entry lines for payroll run =='
select
  je.je_no,
  je.source_type,
  coa.account_code,
  coa.account_name,
  jel.debit,
  jel.credit
from journal_entries je
join journal_entry_lines jel on jel.journal_entry_id = je.id
join chart_of_accounts coa on coa.id = jel.account_id
where je.source_type = 'payroll' and je.source_id = :run_id
order by je.id, jel.line_no;

-- 4. Compare payroll register totals to journal entry amounts
\echo '== Payroll register vs accrual journal (expect matching totals) =='
with register as (
  select
    sum(gross_earnings) as total_gross,
    sum(gross_deductions) as total_deductions,
    sum(reimbursement_amount) as total_reimburse,
    sum(net_salary) as total_net
  from payroll_lines where payroll_run_id = :run_id
),
accrual_je as (
  select je.id from journal_entries je
  where je.source_type = 'payroll' and je.source_id = :run_id
    and je.id = (select accrual_journal_entry_id from payroll_runs where id = :run_id)
),
accrual_debit as (
  select sum(jel.debit) as total_dr from journal_entry_lines jel
  join accrual_je a on a.id = jel.journal_entry_id
)
select
  r.total_gross, r.total_deductions, r.total_reimburse, r.total_net,
  a.total_dr as accrual_total_debit,
  (r.total_gross + r.total_reimburse - a.total_dr) as difference -- expect 0
from register r, accrual_debit a;

-- 5. Confirm trial balance is still balanced (debit side = credit side)
\echo '== Trial balance — total debits vs total credits (expect equal) =='
select
  sum(jel.debit) as total_debits,
  sum(jel.credit) as total_credits,
  sum(jel.debit) - sum(jel.credit) as net -- must be 0
from journal_entry_lines jel
join journal_entries je on je.id = jel.journal_entry_id
where je.status = 'posted';

-- 6. Loan recovery: confirm installment statuses were updated on lock
\echo '== Loan installments recovered in this payroll run =='
select
  li.due_period,
  li.amount,
  li.status,
  pl.id as payroll_line_id
from loan_installments li
join payroll_lines pl on pl.id = li.payroll_line_id
where pl.payroll_run_id = :run_id;

-- 7. Reimbursement: confirm claims were paid in this run
\echo '== Reimbursement claims paid in this payroll run =='
select
  rc.claim_type,
  rc.amount,
  rc.status,
  pl.id as payroll_line_id
from reimbursement_claims rc
join payroll_lines pl on pl.id = rc.payroll_line_id
where pl.payroll_run_id = :run_id;
