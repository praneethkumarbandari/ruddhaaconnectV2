-- ============================================================
-- NUMBERING SEQUENCES — additive fields the Settings "Numbering &
-- Prefixes" page always assumed existed, but no migration ever
-- actually added: separator, suffix, is_active, updated_at.
-- (padding already exists and is what the frontend calls
-- number_length — no rename needed, the backend route below maps
-- between the two names.)
-- Everything here is nullable/defaulted and additive — safe to run
-- regardless of current data.
-- ============================================================

alter table numbering_sequences add column if not exists separator text not null default '-';
alter table numbering_sequences add column if not exists suffix text not null default '';
alter table numbering_sequences add column if not exists is_active boolean not null default true;
alter table numbering_sequences add column if not exists updated_at timestamptz not null default now();
