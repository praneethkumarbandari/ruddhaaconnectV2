-- ============================================================
-- PROJECT ENGINE — PHASE 1: PROJECT TEMPLATES
-- ============================================================
-- A template defines HOW a project's hierarchy is structured — not
-- WHAT KIND of project it is (that's project_categories, which
-- already exists and stays separate; see architecture decision #2:
-- Category and Template answer different questions and neither
-- replaces the other).
--
-- Versioning and customer-copying are two independent axes, both
-- represented as separate rows here rather than separate tables:
--   - Versioning: same template_code, incrementing version — e.g.
--     ('BUILDER_MT', version=1), ('BUILDER_MT', version=2). Only
--     matters for STANDARD templates evolving over time.
--   - Copying: is_standard=false, copied_from_template_id points at
--     the exact standard template row (i.e. exact version) the copy
--     was made from. A customer's copy is then independently
--     editable and never affected by future standard-template
--     versions (architecture decision #2 / spec point 2).
create table project_templates (
  id                    bigserial primary key,
  template_code         text        not null,   -- shared across versions of the same standard template
  template_name         text        not null,
  description           text,
  version               int         not null default 1,
  is_standard           boolean     not null default false,
  -- NEVER true for a customer copy — enforced at the app layer
  -- (see project-templates.ts): standard templates are system-owned
  -- and must never be modified in place (architecture decision #2).
  copied_from_template_id bigint    references project_templates(id),
  is_active             boolean     not null default true,
  created_by            bigint      references employees(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- A given standard template_code can only have one row per version
  -- number — prevents two "BUILDER_MT v2" rows existing by accident.
  -- Customer copies aren't constrained by this (copied_from_template_id
  -- differs per copy, template_code can repeat across many customers'
  -- independent copies of the same origin).
  unique (template_code, version, is_standard)
);
create index idx_project_templates_standard on project_templates(is_standard) where is_standard = true;
create index idx_project_templates_copied_from on project_templates(copied_from_template_id);

-- Template-defined status list for hierarchy nodes (architecture
-- decision #7 / spec point "Status"): the engine understands ONE
-- status field and never hardcodes its values — every template
-- defines its own valid list. Deliberately NOT building transition
-- rules here (which status can move to which) — that's Phase 3's
-- "Status Configuration", not Phase 1. Any status in this list can
-- be set from any other in Phase 1; ordering here is purely for
-- consistent display, not an enforced sequence.
create table template_statuses (
  id           bigserial primary key,
  template_id  bigint      not null references project_templates(id) on delete cascade,
  status_code  text        not null,
  display_name text        not null,
  is_default   boolean     not null default false,
  sort_order   int         not null default 0,
  unique (template_id, status_code)
);
-- At most one default status per template — a node needs exactly one
-- status to fall back to on creation, not an ambiguous choice of two.
create unique index idx_template_statuses_one_default
  on template_statuses(template_id) where is_default = true;

-- Level definitions: the shape of the hierarchy itself. parent_level_code
-- is null for a template's top-most level under Project (e.g. "Room"
-- under Interior, "Tower" under Builder-Multi-Tower) — Project itself
-- is never a row here, since the existing projects table already IS
-- the Project (architecture decision #1: never duplicate the Project
-- master).
create table template_levels (
  id                bigserial primary key,
  template_id       bigint      not null references project_templates(id) on delete cascade,
  level_code        text        not null,   -- e.g. 'tower', 'floor', 'unit', 'room', 'branch', 'classroom'
  display_name      text        not null,
  parent_level_code text,       -- references another row's level_code within the SAME template, or null = direct child of the Project
  sort_order        int         not null default 0,
  created_at        timestamptz not null default now(),
  unique (template_id, level_code)
);
create index idx_template_levels_template on template_levels(template_id);

-- FK-shaped integrity check, done as a trigger rather than a real FK
-- because parent_level_code references another row's level_code
-- WITHIN THE SAME template, not a global id — a plain FK can't express
-- "must match a level_code where template_id also matches this row's
-- template_id".
create or replace function check_template_level_parent() returns trigger as $$
begin
  if new.parent_level_code is not null then
    if not exists (
      select 1 from template_levels
      where template_id = new.template_id and level_code = new.parent_level_code
    ) then
      raise exception 'parent_level_code % does not exist as a level_code within template_id %', new.parent_level_code, new.template_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger trg_check_template_level_parent
  before insert or update on template_levels
  for each row execute function check_template_level_parent();
