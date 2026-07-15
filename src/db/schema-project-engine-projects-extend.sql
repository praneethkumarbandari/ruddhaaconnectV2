-- ============================================================
-- PROJECT ENGINE — PHASE 1: EXTEND THE EXISTING PROJECTS TABLE
-- ============================================================
-- Per architecture decision #1: the existing "projects" table is the
-- single source of truth for Projects. No new Project table. This
-- only adds what's needed for the engine — nothing about the
-- existing category_id, status, or status-transition logic changes
-- here. Project Category and Project Template are different
-- concepts and both stay (architecture decision #2) — category_id is
-- untouched.
--
-- template_id is nullable: an existing project (or a project for a
-- business that has no use for structured hierarchy at all) is never
-- forced to have one. Project-level accounting tagging that already
-- shipped this session (Invoices/Journal Entry -> projects.id) is
-- completely unaffected by this column existing or not.
alter table projects add column if not exists template_id bigint references project_templates(id);
create index if not exists idx_projects_template on projects(template_id);

-- NOTE (deliberately NOT done in Phase 1): projects.status still uses
-- its original hardcoded check constraint and ALLOWED_TRANSITIONS map
-- (see src/lib/projects.ts) — reconciling project-level status with
-- the new template-driven template_statuses system is explicitly
-- Phase 3's "Status Configuration" scope, not Phase 1's. Flagging
-- this here rather than quietly leaving two different status
-- philosophies unmentioned in the same engine.
