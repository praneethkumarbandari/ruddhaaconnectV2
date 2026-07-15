-- ============================================================
-- PROJECT ENGINE — PHASE 1: GENERIC PROJECT HIERARCHY
-- ============================================================
-- One table for every node at every level, for every template, for
-- every industry — a Tower, a Floor, a Unit, a Room, a Branch, a
-- Classroom are all just rows here, distinguished only by which
-- template_levels row they belong to (architecture spec point 5/6).
--
-- parent_node_id is null for a node that's a DIRECT child of the
-- Project itself (e.g. a Room directly under an Interior project, or
-- a Tower directly under a Builder project) — the Project itself is
-- never a row in this table (see the projects-extend migration).
--
-- Dynamic per-level fields (Facing, Corner Charges, Benches, ...) are
-- explicitly NOT part of Phase 1 — that's Phase 2's Dynamic Fields /
-- Hybrid Storage. This table only carries the standard fields every
-- node needs regardless of template, per architecture spec point 5.
create table project_hierarchy_nodes (
  id             bigserial primary key,
  project_id     bigint      not null references projects(id),
  parent_node_id bigint      references project_hierarchy_nodes(id),
  level_id       bigint      not null references template_levels(id),
  node_code      text,
  node_name      text        not null,
  description    text,
  sequence       int         not null default 0,
  status         text        not null,
  -- Validated at the app layer against this project's template's
  -- template_statuses, not a DB check constraint — the valid list is
  -- template-defined data, not a fixed set a CHECK constraint could
  -- express (see project-hierarchy.ts).
  created_by     bigint      references employees(id),
  created_at     timestamptz not null default now(),
  updated_by     bigint      references employees(id),
  updated_at     timestamptz not null default now()
);
create index idx_hierarchy_nodes_project on project_hierarchy_nodes(project_id);
create index idx_hierarchy_nodes_parent on project_hierarchy_nodes(parent_node_id);
create index idx_hierarchy_nodes_level on project_hierarchy_nodes(level_id);

-- FIX (real gap this constraint closes): without it, nothing stops a
-- node from citing a level_id belonging to a DIFFERENT template than
-- its own project is assigned — e.g. a project using "Interior"
-- accidentally gaining a node at Builder's "Floor" level. Enforced as
-- a trigger for the same reason as template_levels' parent-code
-- check: it's a cross-table consistency rule ("this node's level must
-- belong to this node's project's template"), not a plain FK.
create or replace function check_node_level_matches_project_template() returns trigger as $$
declare
  project_template_id bigint;
  level_template_id bigint;
begin
  select template_id into project_template_id from projects where id = new.project_id;
  select template_id into level_template_id from template_levels where id = new.level_id;
  if project_template_id is null then
    raise exception 'Project % has no template assigned — cannot add hierarchy nodes to it yet.', new.project_id;
  end if;
  if project_template_id != level_template_id then
    raise exception 'level_id % belongs to a different template than project % is assigned.', new.level_id, new.project_id;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger trg_check_node_level_matches_project_template
  before insert or update on project_hierarchy_nodes
  for each row execute function check_node_level_matches_project_template();
