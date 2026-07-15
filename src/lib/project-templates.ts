import type { PgClient } from "../db/pool.ts";
import { query, withTransaction } from "../db/pool.ts";

/**
 * Project Templates Service (Project Engine, Phase 1).
 *
 * Owns project_templates / template_levels / template_statuses only.
 * Standard templates (is_standard = true) are system-owned and are
 * NEVER modified in place here — every mutating function in this
 * file that touches levels/statuses first checks is_standard and
 * refuses if true. The only path to a customer-editable template is
 * copyTemplate(), which produces a brand new, independent, non-standard
 * row (architecture decision #2).
 */

export class TemplateNotFoundError extends Error {
  constructor(id: number) { super(`Project template ${id} not found.`); this.name = "TemplateNotFoundError"; }
}
export class StandardTemplateImmutableError extends Error {
  constructor() {
    super("Standard templates are system-owned and cannot be modified. Copy this template first, then edit the copy.");
    this.name = "StandardTemplateImmutableError";
  }
}

export async function listTemplates(filters: { standardOnly?: boolean } = {}) {
  const where = filters.standardOnly ? "where is_standard = true" : "";
  const { rows } = await query(`select * from project_templates ${where} order by template_name, version`);
  return rows;
}

export async function getTemplateWithLevelsAndStatuses(templateId: number) {
  const { rows: templateRows } = await query(`select * from project_templates where id = $1`, [templateId]);
  if (templateRows.length === 0) throw new TemplateNotFoundError(templateId);
  const [{ rows: levels }, { rows: statuses }] = await Promise.all([
    query(`select * from template_levels where template_id = $1 order by sort_order`, [templateId]),
    query(`select * from template_statuses where template_id = $1 order by sort_order`, [templateId]),
  ]);
  return { ...templateRows[0], levels, statuses };
}

/**
 * Standard Template -> Copy -> Customer Template (architecture
 * decision #2). Produces a fully independent row: its own levels, its
 * own statuses, copied by value from the source — never a live
 * reference back to the standard template. A future version of the
 * standard template (e.g. BUILDER_MULTI_TOWER going from v1 to v2)
 * can never retroactively affect a customer's already-made copy.
 */
export async function copyTemplate(client: PgClient, sourceTemplateId: number, newTemplateName: string, createdBy: number | null) {
  const { rows: sourceRows } = await client.query(`select * from project_templates where id = $1`, [sourceTemplateId]);
  if (sourceRows.length === 0) throw new TemplateNotFoundError(sourceTemplateId);
  const source = sourceRows[0];

  const { rows: newTemplateRows } = await client.query(
    `insert into project_templates (template_code, template_name, description, version, is_standard, copied_from_template_id, created_by)
     values ($1, $2, $3, 1, false, $4, $5)
     returning *`,
    [source.template_code, newTemplateName, source.description, sourceTemplateId, createdBy],
  );
  const newTemplate = newTemplateRows[0];

  const { rows: sourceLevels } = await client.query(`select * from template_levels where template_id = $1 order by sort_order`, [sourceTemplateId]);
  // Levels must be inserted in an order where a level's parent already
  // exists (the parent-check trigger enforces this) — sourceLevels is
  // already ordered by sort_order, which every seed template defines
  // parent-before-child, so this preserves that order rather than
  // re-deriving it.
  for (const level of sourceLevels) {
    await client.query(
      `insert into template_levels (template_id, level_code, display_name, parent_level_code, sort_order)
       values ($1, $2, $3, $4, $5)`,
      [newTemplate.id, level.level_code, level.display_name, level.parent_level_code, level.sort_order],
    );
  }

  const { rows: sourceStatuses } = await client.query(`select * from template_statuses where template_id = $1 order by sort_order`, [sourceTemplateId]);
  for (const s of sourceStatuses) {
    await client.query(
      `insert into template_statuses (template_id, status_code, display_name, is_default, sort_order)
       values ($1, $2, $3, $4, $5)`,
      [newTemplate.id, s.status_code, s.display_name, s.is_default, s.sort_order],
    );
  }

  return getTemplateWithLevelsAndStatuses(newTemplate.id);
}

async function assertNotStandard(client: PgClient, templateId: number) {
  const { rows } = await client.query(`select is_standard from project_templates where id = $1`, [templateId]);
  if (rows.length === 0) throw new TemplateNotFoundError(templateId);
  if (rows[0].is_standard) throw new StandardTemplateImmutableError();
}

export type LevelInput = { levelCode: string; displayName: string; parentLevelCode: string | null; sortOrder: number };

/** Full replace of a copy's levels — only ever allowed on a non-standard (copied) template. */
export async function setTemplateLevels(client: PgClient, templateId: number, levels: LevelInput[]) {
  await assertNotStandard(client, templateId);
  await client.query(`delete from template_levels where template_id = $1`, [templateId]);
  for (const l of levels) {
    await client.query(
      `insert into template_levels (template_id, level_code, display_name, parent_level_code, sort_order)
       values ($1, $2, $3, $4, $5)`,
      [templateId, l.levelCode, l.displayName, l.parentLevelCode, l.sortOrder],
    );
  }
  return getTemplateWithLevelsAndStatuses(templateId);
}

export type StatusInput = { statusCode: string; displayName: string; isDefault: boolean; sortOrder: number };

/** Full replace of a copy's status list — only ever allowed on a non-standard (copied) template. */
export async function setTemplateStatuses(client: PgClient, templateId: number, statuses: StatusInput[]) {
  await assertNotStandard(client, templateId);
  if (statuses.filter((s) => s.isDefault).length !== 1) {
    throw new Error("Exactly one status must be marked as the default.");
  }
  await client.query(`delete from template_statuses where template_id = $1`, [templateId]);
  for (const s of statuses) {
    await client.query(
      `insert into template_statuses (template_id, status_code, display_name, is_default, sort_order)
       values ($1, $2, $3, $4, $5)`,
      [templateId, s.statusCode, s.displayName, s.isDefault, s.sortOrder],
    );
  }
  return getTemplateWithLevelsAndStatuses(templateId);
}
