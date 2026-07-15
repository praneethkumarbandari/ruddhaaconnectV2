-- Each tenant gets its own subfolder inside the one shared Google
-- Drive account used for storage — created automatically on first
-- upload, then reused. This is what actually keeps Tenant A's files
-- separate from Tenant B's inside a single Drive account: Drive
-- itself has no concept of "tenant," so the app enforces it by never
-- uploading into or reading from another tenant's folder, and never
-- trusting a file id without checking the owning record's tenant_id
-- in our own database first.
alter table tenants add column if not exists drive_folder_id text;

-- employee_documents.file_reference and project_documents.storage_path
-- already exist as free-text "external reference" fields — reused
-- here to hold the real Google Drive file id, no new column needed
-- for that. Adding what WAS missing: the original filename (project_
-- documents already had file_name; employee_documents didn't) and a
-- mime type on both, so downloads can serve the file back correctly.
alter table employee_documents add column if not exists file_name text;
alter table employee_documents add column if not exists mime_type text;
alter table project_documents add column if not exists mime_type text;
