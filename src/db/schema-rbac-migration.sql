-- ============================================================
-- RBAC MIGRATION: extend the real, dynamic permission system
-- (already used correctly by HR) to every other module.
-- ============================================================
-- Generated directly from the live PERMISSION_MATRIX in
-- src/lib/permissions.ts (transcribed once, programmatically
-- turned into SQL below) so the new system starts out with
-- IDENTICAL real-world behavior to the old one -- this
-- migration changes the MECHANISM, not the actual policy.
-- ============================================================

-- Permission catalog: two codes per module (view/manage),
-- matching the read/write distinction the old matrix used.
insert into permissions (permission_code, module, description) values
  ('chart-of-accounts.view', 'chart-of-accounts', 'Read access to chart-of-accounts.'),
  ('chart-of-accounts.manage', 'chart-of-accounts', 'Full write access to chart-of-accounts.'),
  ('financial-years.view', 'financial-years', 'Read access to financial-years.'),
  ('financial-years.manage', 'financial-years', 'Full write access to financial-years.'),
  ('journal-entries.view', 'journal-entries', 'Read access to journal-entries.'),
  ('journal-entries.manage', 'journal-entries', 'Full write access to journal-entries.'),
  ('reports.view', 'reports', 'Read access to reports.'),
  ('reports.manage', 'reports', 'Full write access to reports.'),
  ('customers.view', 'customers', 'Read access to customers.'),
  ('customers.manage', 'customers', 'Full write access to customers.'),
  ('vendors.view', 'vendors', 'Read access to vendors.'),
  ('vendors.manage', 'vendors', 'Full write access to vendors.'),
  ('sales-invoices.view', 'sales-invoices', 'Read access to sales-invoices.'),
  ('sales-invoices.manage', 'sales-invoices', 'Full write access to sales-invoices.'),
  ('purchase-invoices.view', 'purchase-invoices', 'Read access to purchase-invoices.'),
  ('purchase-invoices.manage', 'purchase-invoices', 'Full write access to purchase-invoices.'),
  ('receipts.view', 'receipts', 'Read access to receipts.'),
  ('receipts.manage', 'receipts', 'Full write access to receipts.'),
  ('payments.view', 'payments', 'Read access to payments.'),
  ('payments.manage', 'payments', 'Full write access to payments.'),
  ('contra.view', 'contra', 'Read access to contra.'),
  ('contra.manage', 'contra', 'Full write access to contra.'),
  ('credit-notes.view', 'credit-notes', 'Read access to credit-notes.'),
  ('credit-notes.manage', 'credit-notes', 'Full write access to credit-notes.'),
  ('debit-notes.view', 'debit-notes', 'Read access to debit-notes.'),
  ('debit-notes.manage', 'debit-notes', 'Full write access to debit-notes.'),
  ('bank-import.view', 'bank-import', 'Read access to bank-import.'),
  ('bank-import.manage', 'bank-import', 'Full write access to bank-import.'),
  ('bank-accounts.view', 'bank-accounts', 'Read access to bank-accounts.'),
  ('bank-accounts.manage', 'bank-accounts', 'Full write access to bank-accounts.'),
  ('projects.view', 'projects', 'Read access to projects.'),
  ('projects.manage', 'projects', 'Full write access to projects.'),
  ('project-categories.view', 'project-categories', 'Read access to project-categories.'),
  ('project-categories.manage', 'project-categories', 'Full write access to project-categories.'),
  ('employees.view', 'employees', 'Read access to employees.'),
  ('employees.manage', 'employees', 'Full write access to employees.'),
  ('inventory.view', 'inventory', 'Read access to inventory.'),
  ('inventory.manage', 'inventory', 'Full write access to inventory.'),
  ('customer-requests.view', 'customer-requests', 'Read access to customer-requests.'),
  ('customer-requests.manage', 'customer-requests', 'Full write access to customer-requests.'),
  ('costing.view', 'costing', 'Read access to costing.'),
  ('costing.manage', 'costing', 'Full write access to costing.'),
  ('crm.view', 'crm', 'Read access to crm.'),
  ('crm.manage', 'crm', 'Full write access to crm.'),
  ('audit-log.view', 'audit-log', 'Read access to audit-log.'),
  ('audit-log.manage', 'audit-log', 'Full write access to audit-log.')
on conflict (permission_code) do nothing;

-- New roles, mirroring the old static role names exactly so
-- the employee.role -> user_roles backfill below is a direct,
-- unambiguous mapping, not a guess.
insert into roles (role_code, role_name, description, is_system) values
  ('ACCOUNTANT', 'Accountant', 'Full accounting access; read-only on projects/CRM/audit.', false),
  ('PROJECT_MANAGER', 'Project Manager', 'Full project/costing access; read-only elsewhere.', false),
  ('SALES_ROLE', 'Sales', 'Full CRM/sales-invoice/customer-request access.', false),
  ('VIEWER_ROLE', 'Viewer', 'Read-only access to every module.', false)
on conflict (role_code) do nothing;

-- Grant each new role exactly what the old static matrix gave it.
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'ACCOUNTANT' and p.permission_code in ('chart-of-accounts.view', 'chart-of-accounts.manage', 'financial-years.view', 'financial-years.manage', 'journal-entries.view', 'journal-entries.manage', 'reports.view', 'customers.view', 'customers.manage', 'vendors.view', 'vendors.manage', 'sales-invoices.view', 'sales-invoices.manage', 'purchase-invoices.view', 'purchase-invoices.manage', 'receipts.view', 'receipts.manage', 'payments.view', 'payments.manage', 'contra.view', 'contra.manage', 'credit-notes.view', 'credit-notes.manage', 'debit-notes.view', 'debit-notes.manage', 'bank-import.view', 'bank-import.manage', 'bank-accounts.view', 'bank-accounts.manage', 'projects.view', 'project-categories.view', 'employees.view', 'inventory.view', 'customer-requests.view', 'costing.view')
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'PROJECT_MANAGER' and p.permission_code in ('chart-of-accounts.view', 'financial-years.view', 'journal-entries.view', 'reports.view', 'customers.view', 'vendors.view', 'sales-invoices.view', 'purchase-invoices.view', 'receipts.view', 'payments.view', 'contra.view', 'credit-notes.view', 'debit-notes.view', 'bank-import.view', 'bank-accounts.view', 'projects.view', 'projects.manage', 'project-categories.view', 'project-categories.manage', 'employees.view', 'inventory.view', 'customer-requests.view', 'costing.view', 'costing.manage', 'crm.view')
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'SALES_ROLE' and p.permission_code in ('chart-of-accounts.view', 'financial-years.view', 'journal-entries.view', 'reports.view', 'customers.view', 'customers.manage', 'vendors.view', 'sales-invoices.view', 'sales-invoices.manage', 'purchase-invoices.view', 'receipts.view', 'receipts.manage', 'payments.view', 'contra.view', 'credit-notes.view', 'credit-notes.manage', 'debit-notes.view', 'bank-import.view', 'bank-accounts.view', 'projects.view', 'project-categories.view', 'employees.view', 'inventory.view', 'customer-requests.view', 'customer-requests.manage', 'costing.view', 'crm.view', 'crm.manage')
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'VIEWER_ROLE' and p.permission_code in ('chart-of-accounts.view', 'financial-years.view', 'journal-entries.view', 'reports.view', 'customers.view', 'vendors.view', 'sales-invoices.view', 'purchase-invoices.view', 'receipts.view', 'payments.view', 'contra.view', 'credit-notes.view', 'debit-notes.view', 'bank-import.view', 'bank-accounts.view', 'projects.view', 'project-categories.view', 'employees.view', 'inventory.view', 'customer-requests.view', 'costing.view', 'crm.view', 'audit-log.view')
on conflict do nothing;

-- SYSTEM_ADMIN (already exists) gets every new permission too --
-- it already bypasses checks per lib/rbac-permissions.ts, but
-- granting explicitly keeps the grant table itself accurate
-- and auditable, not reliant on an implicit bypass alone.
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'SYSTEM_ADMIN' and p.permission_code in ('chart-of-accounts.view', 'financial-years.view', 'journal-entries.view', 'reports.view', 'customers.view', 'vendors.view', 'sales-invoices.view', 'purchase-invoices.view', 'receipts.view', 'payments.view', 'contra.view', 'credit-notes.view', 'debit-notes.view', 'bank-import.view', 'bank-accounts.view', 'projects.view', 'project-categories.view', 'employees.view', 'inventory.view', 'customer-requests.view', 'costing.view', 'crm.view', 'audit-log.view', 'chart-of-accounts.manage', 'financial-years.manage', 'journal-entries.manage', 'reports.manage', 'customers.manage', 'vendors.manage', 'sales-invoices.manage', 'purchase-invoices.manage', 'receipts.manage', 'payments.manage', 'contra.manage', 'credit-notes.manage', 'debit-notes.manage', 'bank-import.manage', 'bank-accounts.manage', 'projects.manage', 'project-categories.manage', 'employees.manage', 'inventory.manage', 'customer-requests.manage', 'costing.manage', 'crm.manage', 'audit-log.manage')
on conflict do nothing;

-- ============================================================
-- CRITICAL: backfill user_roles for every EXISTING employee,
-- from their current employees.role column. Without this,
-- every real employee would lose all access the instant any
-- route switches to checking the new system, since the new
-- system has no idea an old employees.role value like
-- 'accountant' should mean anything at all.
-- ============================================================
insert into user_roles (employee_id, role_id)
select e.id, r.id from employees e, roles r
where e.role = 'super_admin' and r.role_code = 'SYSTEM_ADMIN'
on conflict do nothing;

insert into user_roles (employee_id, role_id)
select e.id, r.id from employees e, roles r
where e.role = 'admin' and r.role_code = 'SYSTEM_ADMIN'
on conflict do nothing;

insert into user_roles (employee_id, role_id)
select e.id, r.id from employees e, roles r
where e.role = 'accountant' and r.role_code = 'ACCOUNTANT'
on conflict do nothing;

insert into user_roles (employee_id, role_id)
select e.id, r.id from employees e, roles r
where e.role = 'project_manager' and r.role_code = 'PROJECT_MANAGER'
on conflict do nothing;

insert into user_roles (employee_id, role_id)
select e.id, r.id from employees e, roles r
where e.role = 'sales' and r.role_code = 'SALES_ROLE'
on conflict do nothing;

insert into user_roles (employee_id, role_id)
select e.id, r.id from employees e, roles r
where e.role = 'viewer' and r.role_code = 'VIEWER_ROLE'
on conflict do nothing;

-- NOTE on 'hr': the old static role 'hr' and the new
-- HR_ADMIN/HR_VIEWER roles are NOT the same concept -- HR_ADMIN/
-- HR_VIEWER already exist and already gate the real HR module
-- routes correctly. An employee with employees.role = 'hr' today
-- only ever had 'employees: read' under the OLD matrix (see the
-- comment in lib/permissions.ts) -- the equivalent under the new
-- system is HR_VIEWER, not a new 'HR' role that would duplicate
-- HR_ADMIN/HR_VIEWER's existing purpose.
insert into user_roles (employee_id, role_id)
select e.id, r.id from employees e, roles r
where e.role = 'hr' and r.role_code = 'HR_VIEWER'
on conflict do nothing;