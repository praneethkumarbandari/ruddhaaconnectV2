-- ============================================================
-- DOCUMENT TEMPLATES MODULE (new)
-- ============================================================
-- A reusable named-template library — e.g. email bodies, notice
-- letters, standard clauses — distinct from pdf_template_style
-- (which only controls Invoice/Receipt/Payment print layout, see
-- content/pdf-print-styles.html, unaffected by this table).
create table if not exists document_templates (
  id           bigserial primary key,
  name         text        not null,
  category     text        not null default 'general',
  subject      text,                          -- optional — relevant for email-type templates
  body         text        not null default '',
  is_active    boolean     not null default true,
  created_by   bigint      references employees(id),
  updated_by   bigint      references employees(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_document_templates_category on document_templates(category);
create index if not exists idx_document_templates_name on document_templates(name);

insert into permissions (permission_code, module, description) values
  ('templates.view',   'templates', 'View document templates.'),
  ('templates.manage', 'templates', 'Create, update, duplicate, deactivate document templates.')
on conflict (permission_code) do nothing;
