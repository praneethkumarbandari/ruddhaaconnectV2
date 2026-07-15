-- ============================================================
-- PROJECT ENGINE — PHASE 1: BUILDER TEMPLATE (standard, seeded)
-- ============================================================
-- Two Builder variants seeded — Multi-Tower (Project -> Tower ->
-- Floor -> Unit) and Independent Houses (Project -> Unit, no Tower
-- or Floor at all). Phase 1's scope named "Builder Template"
-- singular, but seeding both costs nothing extra and is the concrete
-- proof that the engine genuinely supports a template skipping levels
-- entirely (Tower being optional was the very first requirement in
-- this whole design) rather than always assuming a fixed depth.

insert into project_templates (template_code, template_name, description, version, is_standard, is_active)
values
  ('BUILDER_MULTI_TOWER', 'Builder - Multi Tower', 'Project -> Tower -> Floor -> Unit', 1, true, true),
  ('BUILDER_INDEPENDENT', 'Builder - Independent Houses', 'Project -> Unit (no Tower or Floor)', 1, true, true)
on conflict (template_code, version, is_standard) do nothing;

-- Levels for Builder - Multi Tower
insert into template_levels (template_id, level_code, display_name, parent_level_code, sort_order)
select id, 'tower', 'Tower', null, 1 from project_templates where template_code = 'BUILDER_MULTI_TOWER' and is_standard = true
union all
select id, 'floor', 'Floor', 'tower', 2 from project_templates where template_code = 'BUILDER_MULTI_TOWER' and is_standard = true
union all
select id, 'unit', 'Unit', 'floor', 3 from project_templates where template_code = 'BUILDER_MULTI_TOWER' and is_standard = true
on conflict (template_id, level_code) do nothing;

-- Levels for Builder - Independent Houses: Unit is a DIRECT child of
-- the Project (parent_level_code = null) — no Tower, no Floor.
insert into template_levels (template_id, level_code, display_name, parent_level_code, sort_order)
select id, 'unit', 'Unit', null, 1 from project_templates where template_code = 'BUILDER_INDEPENDENT' and is_standard = true
on conflict (template_id, level_code) do nothing;

-- Same status list for both Builder variants — Draft/Active/Completed/
-- Cancelled/Archived, exactly the example list from the spec. This is
-- data, not engine logic: a different template could ship an entirely
-- different list without touching any code.
insert into template_statuses (template_id, status_code, display_name, is_default, sort_order)
select id, s.code, s.name, s.is_default, s.sort_order
from project_templates,
  (values
    ('draft', 'Draft', true, 1),
    ('active', 'Active', false, 2),
    ('completed', 'Completed', false, 3),
    ('cancelled', 'Cancelled', false, 4),
    ('archived', 'Archived', false, 5)
  ) as s(code, name, is_default, sort_order)
where template_code in ('BUILDER_MULTI_TOWER', 'BUILDER_INDEPENDENT') and is_standard = true
on conflict (template_id, status_code) do nothing;

insert into permissions (permission_code, module, description) values
  ('project_templates.view',   'projects', 'View project templates.'),
  ('project_templates.manage', 'projects', 'Copy standard templates and edit customer-owned template copies.'),
  ('project_hierarchy.view',   'projects', 'View a project''s hierarchy nodes (Towers, Floors, Units, Rooms, etc.).'),
  ('project_hierarchy.manage', 'projects', 'Create, edit, and deactivate a project''s hierarchy nodes.')
on conflict (permission_code) do nothing;
