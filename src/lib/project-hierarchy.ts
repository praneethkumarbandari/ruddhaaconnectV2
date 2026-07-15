import type { PgClient } from "../db/pool.ts";
import { query } from "../db/pool.ts";

/**
 * Project Hierarchy Service (Project Engine, Phase 1) — Universal CRUD.
 *
 * This is deliberately the ONLY create/update/delete logic for every
 * hierarchy level, for every template, for every industry (architecture
 * spec points 6/9/10/11). There is no separate "create a Tower"
 * function versus "create a Room" function — a Tower and a Room are
 * both just a node at a different level_id, validated against
 * whatever that project's template says is valid.
 *
 * Deliberately NOT in Phase 1 (see the Phase roadmap):
 *  - dynamic per-level fields / hybrid storage (Phase 2)
 *  - hierarchical numbering (Phase 2)
 *  - full business-rule-driven validation, e.g. "max 20 floors" (Phase 3)
 *  - reparenting / move (explicitly deferred per architecture decision
 *    #4 — moving a node safely requires dependent-record checks that
 *    don't exist as a concept until node-level transaction tagging
 *    ships, which is its own explicitly-deferred piece)
 *  - permissions per level (Phase 3) — gated today only by the same
 *    blanket project_hierarchy.manage permission for every level
 */

export class ProjectHasNoTemplateError extends Error {
  constructor(projectId: number) {
    super(`Project ${projectId} has no template assigned — assign one before adding hierarchy nodes.`);
    this.name = "ProjectHasNoTemplateError";
  }
}
export class NodeNotFoundError extends Error {
  constructor(id: number) { super(`Hierarchy node ${id} not found.`); this.name = "NodeNotFoundError"; }
}
export class InvalidLevelForTemplateError extends Error {
  constructor() { super("That level does not belong to this project's template."); this.name = "InvalidLevelForTemplateError"; }
}
export class InvalidParentError extends Error {
  constructor(detail: string) { super(`Invalid parent: ${detail}`); this.name = "InvalidParentError"; }
}
export class InvalidStatusForTemplateError extends Error {
  constructor(status: string) {
    super(`"${status}" is not a valid status for this project's template.`);
    this.name = "InvalidStatusForTemplateError";
  }
}
export class NodeHasChildrenError extends Error {
  constructor(id: number) {
    super(`Node ${id} has child nodes and cannot be deleted. Remove or reassign its children first.`);
    this.name = "NodeHasChildrenError";
  }
}

async function getProjectTemplateId(client: PgClient, projectId: number): Promise<number> {
  const { rows } = await client.query(`select template_id from projects where id = $1`, [projectId]);
  if (rows.length === 0 || !rows[0].template_id) throw new ProjectHasNoTemplateError(projectId);
  return rows[0].template_id;
}

async function validateStatus(client: PgClient, templateId: number, status: string): Promise<void> {
  const { rows } = await client.query(
    `select 1 from template_statuses where template_id = $1 and status_code = $2`,
    [templateId, status],
  );
  if (rows.length === 0) throw new InvalidStatusForTemplateError(status);
}

async function getDefaultStatus(client: PgClient, templateId: number): Promise<string> {
  const { rows } = await client.query(
    `select status_code from template_statuses where template_id = $1 and is_default = true limit 1`,
    [templateId],
  );
  return rows[0]?.status_code ?? "draft";
}

/**
 * Returns the full node list for a project as a flat array (each row
 * carries its own parent_node_id) — assembling into a visual tree is
 * the frontend's job, same principle as every other list endpoint in
 * this app: the backend returns real rows, the UI shapes them for
 * display.
 */
export async function getProjectHierarchy(projectId: number) {
  const { rows } = await query(
    `select n.*, tl.level_code, tl.display_name as level_display_name, tl.sort_order as level_sort_order
     from project_hierarchy_nodes n
     join template_levels tl on tl.id = n.level_id
     where n.project_id = $1
     order by tl.sort_order, n.sequence, n.id`,
    [projectId],
  );
  return rows;
}

export type CreateNodeInput = {
  projectId: number;
  parentNodeId?: number | null;
  levelId: number;
  nodeCode?: string | null;
  nodeName: string;
  description?: string | null;
  sequence?: number;
  status?: string | null;
  userId: number | null;
};

export async function createNode(client: PgClient, input: CreateNodeInput) {
  const templateId = await getProjectTemplateId(client, input.projectId);

  const { rows: levelRows } = await client.query(`select * from template_levels where id = $1`, [input.levelId]);
  if (levelRows.length === 0 || levelRows[0].template_id !== templateId) throw new InvalidLevelForTemplateError();
  const level = levelRows[0];

  // Structural validation (Phase 1's scope — NOT the fuller
  // business-rule-driven "Hierarchy Validation" from Phase 2/3, just
  // enough for the engine to refuse an obviously wrong shape): a
  // node's parent must actually be at the level this level's template
  // definition says is its parent.
  if (input.parentNodeId) {
    const { rows: parentRows } = await client.query(
      `select n.*, tl.level_code as parent_level_code
       from project_hierarchy_nodes n join template_levels tl on tl.id = n.level_id
       where n.id = $1`,
      [input.parentNodeId],
    );
    if (parentRows.length === 0) throw new InvalidParentError("parent node does not exist.");
    const parent = parentRows[0];
    if (parent.project_id !== input.projectId) throw new InvalidParentError("parent node belongs to a different project.");
    if (parent.parent_level_code !== level.parent_level_code) {
      throw new InvalidParentError(`"${level.display_name}" must be created under a "${level.parent_level_code ?? "(none — direct child of the project)"}" node.`);
    }
  } else if (level.parent_level_code !== null) {
    throw new InvalidParentError(`"${level.display_name}" must be created under a "${level.parent_level_code}" node, not directly under the project.`);
  }

  const status = input.status || (await getDefaultStatus(client, templateId));
  await validateStatus(client, templateId, status);

  const { rows } = await client.query(
    `insert into project_hierarchy_nodes
       (project_id, parent_node_id, level_id, node_code, node_name, description, sequence, status, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     returning *`,
    [
      input.projectId, input.parentNodeId ?? null, input.levelId, input.nodeCode ?? null,
      input.nodeName, input.description ?? null, input.sequence ?? 0, status, input.userId,
    ],
  );
  return rows[0];
}

export type UpdateNodeInput = {
  nodeName?: string;
  description?: string | null;
  sequence?: number;
  status?: string;
  userId: number | null;
};

export async function updateNode(client: PgClient, nodeId: number, input: UpdateNodeInput) {
  const { rows: existing } = await client.query(`select * from project_hierarchy_nodes where id = $1`, [nodeId]);
  if (existing.length === 0) throw new NodeNotFoundError(nodeId);

  if (input.status) {
    const templateId = await getProjectTemplateId(client, existing[0].project_id);
    await validateStatus(client, templateId, input.status);
  }

  const { rows } = await client.query(
    `update project_hierarchy_nodes set
       node_name = coalesce($2, node_name),
       description = $3,
       sequence = coalesce($4, sequence),
       status = coalesce($5, status),
       updated_by = $6, updated_at = now()
     where id = $1
     returning *`,
    [nodeId, input.nodeName ?? null, input.description ?? existing[0].description, input.sequence ?? null, input.status ?? null, input.userId],
  );
  return rows[0];
}

/**
 * Real delete, guarded — Phase 1 has no dependent-record concept yet
 * (node-level transaction tagging is explicitly deferred), so the
 * only real risk right now is orphaning children. Once node-level
 * tagging exists, this must also refuse deletion of a node with
 * linked transactions — noted here so that requirement isn't lost
 * before Phase 2/3 land.
 */
export async function deleteNode(client: PgClient, nodeId: number) {
  const { rows: existing } = await client.query(`select * from project_hierarchy_nodes where id = $1`, [nodeId]);
  if (existing.length === 0) throw new NodeNotFoundError(nodeId);

  const { rows: children } = await client.query(`select 1 from project_hierarchy_nodes where parent_node_id = $1 limit 1`, [nodeId]);
  if (children.length > 0) throw new NodeHasChildrenError(nodeId);

  await client.query(`delete from project_hierarchy_nodes where id = $1`, [nodeId]);
  return { deleted: true };
}
