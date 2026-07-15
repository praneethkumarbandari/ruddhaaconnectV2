-- FIX: Settings was gated in the sidebar (hidden from non-admins) but
-- had zero backend enforcement — settings.html wrote straight to
-- Supabase from the browser, bypassing the Express permission system
-- entirely, same risk pattern flagged in earlier audits. This adds
-- the real permissions and a real backend route (src/routes/
-- settings.ts) now checks them, matching every other gated module.
insert into permissions (permission_code, module, description) values
  ('admin.settings.view',   'admin', 'View business settings (branding, theme, numbering, PDF template style).'),
  ('admin.settings.manage', 'admin', 'Change business settings (branding, theme, numbering, PDF template style).')
on conflict (permission_code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.role_code = 'SYSTEM_ADMIN' and p.permission_code in ('admin.settings.view', 'admin.settings.manage')
on conflict do nothing;
