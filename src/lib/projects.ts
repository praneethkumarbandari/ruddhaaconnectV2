import type { PgClient } from "../db/pool.ts";
import { pool, query } from "../db/pool.ts";
import { logProjectActivity } from "./project-activity-log.ts";

/**
 * Project Service (Project Management module).
 *
 * Owns projects.* only. Never queries journal_entries or any of the
 * six tagged accounting document tables — that boundary belongs to
 * project-reports.ts exclusively (see the Phase 3 implementation
 * strategy's Reporting Service boundary rule).
 */

export class ProjectNotFoundError extends Error {
  constructor(id: number) { super(`Project ${id} not found.`); this.name = "ProjectNotFoundError"; }
}
export class DuplicateProjectCodeError extends Error {
  constructor(code: string) { super(`Project code "${code}" already exists.`); this.name = "DuplicateProjectCodeError"; }
}
export class InvalidStatusTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot move a project from '${from}' to '${to}'.`);
    this.name = "InvalidStatusTransitionError";
  }
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["active"],
  active: ["on_hold", "closing"],
  on_hold: ["active"],
  closing: ["closed", "active"],
  closed: [], // terminal — a closed project is never reopened; if a real correction
              // is needed later, that's an Accounting-side reversal on the tagged
              // transactions, not a Project Management status change (see Phase 1's
              // "project status never gates or is gated by Accounting" rule).
};

export type CreateProjectInput = {
  projectCode: string;
  projectName: string;
  categoryId?: number | null;
  customerId?: number | null;
  templateId?: number | null;
  startDate?: string | null;
  targetEndDate?: string | null;
  createdBy: number | null;
};

export async function createProject(client: PgClient, input: CreateProjectInput) {
  const { rows: existing } = await client.query(
    `select id from projects where project_code = $1`,
    [input.projectCode],
  );
  if (existing.length > 0) throw new DuplicateProjectCodeError(input.projectCode);

  const { rows } = await client.query(
    `insert into projects (project_code, project_name, category_id, customer_id, template_id, start_date, target_end_date, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      input.projectCode,
      input.projectName,
      input.categoryId ?? null,
      input.customerId ?? null,
      input.templateId ?? null,
      input.startDate ?? null,
      input.targetEndDate ?? null,
      input.createdBy,
    ],
  );
  await logProjectActivity(client, rows[0].id, input.createdBy, "project_created", { projectCode: input.projectCode });
  return rows[0];
}

export async function listProjectCategories() {
  const { rows } = await query(`select * from project_categories order by name asc`);
  return rows;
}

export async function createProjectCategory(name: string, description?: string | null) {
  const { rows } = await query(
    `insert into project_categories (name, description) values ($1, $2) returning *`,
    [name, description ?? null],
  );
  return rows[0];
}

export async function getProject(projectId: number) {
  const { rows } = await query(`select * from projects where id = $1`, [projectId]);
  if (rows.length === 0) throw new ProjectNotFoundError(projectId);
  return rows[0];
}

export async function listProjects(filters: { status?: string; categoryId?: number; customerId?: number } = {}) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  if (filters.categoryId) { params.push(filters.categoryId); conditions.push(`category_id = $${params.length}`); }
  if (filters.customerId) { params.push(filters.customerId); conditions.push(`customer_id = $${params.length}`); }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(
    `select p.*, c.customer_name, pc.name as category_name
     from projects p
     left join customers c on c.id = p.customer_id
     left join project_categories pc on pc.id = p.category_id
     ${where}
     order by p.created_at desc`,
    params,
  );
  return rows;
}

export async function changeProjectStatus(
  client: PgClient,
  projectId: number,
  newStatus: string,
  performedBy: number | null = null,
) {
  const { rows: existingRows } = await client.query(`select * from projects where id = $1`, [projectId]);
  if (existingRows.length === 0) throw new ProjectNotFoundError(projectId);
  const current = existingRows[0];

  const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new InvalidStatusTransitionError(current.status, newStatus);
  }

  const { rows } = await client.query(
    `update projects
     set status = $2,
         updated_at = now(),
         actual_end_date = case when $2 = 'closed' then coalesce(actual_end_date, current_date) else actual_end_date end
     where id = $1
     returning *`,
    [projectId, newStatus],
  );
  await logProjectActivity(client, projectId, performedBy, "status_changed", { from: current.status, to: newStatus });
  return rows[0];
}
