-- NOT wired into npm run migrate — deliberately requires running by
-- hand, same reasoning as schema-multitenancy-enforce.sql: this
-- changes real, enforced database behavior and deserves a deliberate
-- decision to run, not an automatic one bundled in with everything
-- else.
--
-- An audit suggested a full "SECURITY DEFINER function backing
-- postJournalEntry(), with direct INSERT revoked from the app role."
-- That's a bigger, riskier change than it sounds: it would mean
-- reimplementing balance validation, financial-year lookup, and
-- atomic voucher numbering entirely in PL/pgSQL, all without a live
-- database available to actually test it against. Getting that wrong
-- could break every accounting write in the app. Not something to
-- build and ship blind.
--
-- This does the smaller, well-scoped, high-value piece instead: the
-- codebase's own stated principle is "reversal, not cancellation" —
-- once a journal entry is posted, it is never supposed to be edited
-- or deleted again, only reversed via a new, separate entry. Today
-- that's enforced by convention (no application code path does it),
-- not by the database. This trigger makes it a real, unbreakable
-- database rule: any UPDATE or DELETE attempt on a journal_entries or
-- journal_entry_lines row whose parent status is 'posted' is
-- rejected outright, regardless of what wrote the query — a future
-- bug, a compromised credential, or a well-meaning manual "just this
-- once" fix in the SQL console.
--
-- Explicitly does NOT block inserting a new reversing entry (source
-- app logic already does this correctly via reverses_je_id /
-- reversed_by_je_id) — only blocks mutating a row that's already
-- posted.

create or replace function reject_posted_journal_mutation() returns trigger as $$
begin
  if TG_OP = 'DELETE' then
    if OLD.status = 'posted' then
      raise exception 'Posted journal entries cannot be deleted — reverse it with a new entry instead.';
    end if;
    return OLD;
  end if;

  -- UPDATE: block if the row WAS posted, unless this specific update
  -- is the one legitimate case — marking it as reversed (setting
  -- reversed_by_je_id) after a new reversing entry is posted against
  -- it. Everything else about a posted row is frozen.
  if OLD.status = 'posted' then
    if NEW.status != OLD.status
       or NEW.je_no != OLD.je_no
       or NEW.entry_date != OLD.entry_date
       or NEW.narration != OLD.narration
       or NEW.financial_year_id != OLD.financial_year_id
    then
      raise exception 'Posted journal entries cannot be modified — reverse it with a new entry instead.';
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_reject_posted_journal_mutation on journal_entries;
create trigger trg_reject_posted_journal_mutation
  before update or delete on journal_entries
  for each row execute function reject_posted_journal_mutation();

create or replace function reject_posted_journal_line_mutation() returns trigger as $$
declare
  parent_status text;
begin
  select status into parent_status from journal_entries
    where id = coalesce(NEW.journal_entry_id, OLD.journal_entry_id);

  if parent_status = 'posted' then
    raise exception 'Lines of a posted journal entry cannot be modified or deleted — reverse the entry instead.';
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_reject_posted_journal_line_mutation on journal_entry_lines;
create trigger trg_reject_posted_journal_line_mutation
  before update or delete on journal_entry_lines
  for each row execute function reject_posted_journal_line_mutation();
