-- ------------------------------------------------------------
-- Ruddhaa ERP — Role-Based Access Control (RBAC), first cut
--
-- One additive, non-null column with a safe default. Every existing
-- employee row gets 'viewer' (the least-privileged role) rather than
-- silently inheriting full access — an explicit choice, not an
-- oversight: a real deployment must consciously upgrade real users'
-- roles rather than have a migration quietly grant them power they
-- were never assigned. The seed script's own admin user is the one
-- exception, explicitly set to 'super_admin' right after this runs.
-- ------------------------------------------------------------

alter table employees
  add column role text not null default 'viewer'
  check (role in ('super_admin','admin','accountant','project_manager','hr','sales','viewer'));

create index idx_employees_role on employees(role);
