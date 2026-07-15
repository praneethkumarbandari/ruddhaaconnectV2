-- ------------------------------------------------------------
-- Ruddhaa Project Management — rollback for schema-projectmanagement.sql
--
-- Strict reverse dependency order: the ALTER-added columns on existing
-- accounting tables must drop before `projects` itself can be dropped
-- (they hold FKs to it); dependent PM tables drop before the tables
-- they reference.
-- ------------------------------------------------------------

alter table bank_import_rows   drop column if exists project_id;
alter table debit_notes        drop column if exists project_id;
alter table credit_notes       drop column if exists project_id;
alter table payments           drop column if exists project_id;
alter table receipts           drop column if exists project_id;
alter table purchase_invoices  drop column if exists project_id;
alter table sales_invoices     drop column if exists project_id;
alter table journal_entries    drop column if exists project_id;

drop table if exists project_activity_log;
drop table if exists project_estimates;
drop table if exists project_budget;
drop table if exists project_budget_versions;
drop table if exists project_tasks;
drop table if exists project_milestones;
drop table if exists project_notes;
drop table if exists project_documents;
drop table if exists project_members;
drop table if exists projects;
drop table if exists project_categories;
