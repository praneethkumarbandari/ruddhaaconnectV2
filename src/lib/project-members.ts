import type { PgClient } from "../db/pool.ts";
import { pool, query } from "../db/pool.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { logProjectActivity } from "./project-activity-log.ts";

export class MemberAlreadyAssignedError extends Error {
  constructor(projectId: number, employeeId: number) {
    super(`Employee ${employeeId} is already a member of project ${projectId}.`);
    this.name = "MemberAlreadyAssignedError";
  }
}
export class MemberNotFoundError extends Error {
  constructor(projectId: number, employeeId: number) {
    super(`Employee ${employeeId} is not a member of project ${projectId}.`);
    this.name = "MemberNotFoundError";
  }
}

async function assertProjectExists(client: PgClient, projectId: number) {
  const { rows } = await client.query(`select id from projects where id = $1`, [projectId]);
  if (rows.length === 0) throw new ProjectNotFoundError(projectId);
}

export async function addMember(
  client: PgClient,
  projectId: number,
  employeeId: number,
  role: "manager" | "member" | "viewer" = "member",
  performedBy: number | null = null,
) {
  await assertProjectExists(client, projectId);
  const { rows: existing } = await client.query(
    `select id from project_members where project_id = $1 and employee_id = $2`,
    [projectId, employeeId],
  );
  if (existing.length > 0) throw new MemberAlreadyAssignedError(projectId, employeeId);

  const { rows } = await client.query(
    `insert into project_members (project_id, employee_id, role) values ($1, $2, $3) returning *`,
    [projectId, employeeId, role],
  );
  await logProjectActivity(client, projectId, performedBy, "member_added", { employeeId, role });
  return rows[0];
}

export async function removeMember(
  client: PgClient,
  projectId: number,
  employeeId: number,
  performedBy: number | null = null,
) {
  const { rows } = await client.query(
    `delete from project_members where project_id = $1 and employee_id = $2 returning *`,
    [projectId, employeeId],
  );
  if (rows.length === 0) throw new MemberNotFoundError(projectId, employeeId);
  await logProjectActivity(client, projectId, performedBy, "member_removed", { employeeId });
  return rows[0];
}

export async function listMembers(projectId: number) {
  const { rows } = await query(
    `select pm.*, e.username, e.employee_name
     from project_members pm
     join employees e on e.id = pm.employee_id
     where pm.project_id = $1
     order by pm.added_at asc`,
    [projectId],
  );
  return rows;
}
