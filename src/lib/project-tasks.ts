import type { PgClient } from "../db/pool.ts";
import { pool, query } from "../db/pool.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { logProjectActivity } from "./project-activity-log.ts";

export class MilestoneNotFoundError extends Error {
  constructor(id: number) { super(`Milestone ${id} not found.`); this.name = "MilestoneNotFoundError"; }
}
export class TaskNotFoundError extends Error {
  constructor(id: number) { super(`Task ${id} not found.`); this.name = "TaskNotFoundError"; }
}
export class MilestoneWrongProjectError extends Error {
  constructor(milestoneId: number, projectId: number) {
    super(`Milestone ${milestoneId} does not belong to project ${projectId}.`);
    this.name = "MilestoneWrongProjectError";
  }
}

async function assertProjectExists(client: PgClient, projectId: number) {
  const { rows } = await client.query(`select id from projects where id = $1`, [projectId]);
  if (rows.length === 0) throw new ProjectNotFoundError(projectId);
}

export async function createMilestone(
  client: PgClient,
  projectId: number,
  milestoneName: string,
  targetDate: string | null,
  performedBy: number | null,
) {
  await assertProjectExists(client, projectId);
  const { rows } = await client.query(
    `insert into project_milestones (project_id, milestone_name, target_date) values ($1, $2, $3) returning *`,
    [projectId, milestoneName, targetDate],
  );
  await logProjectActivity(client, projectId, performedBy, "milestone_created", { milestoneName });
  return rows[0];
}

export async function updateMilestoneStatus(
  client: PgClient,
  milestoneId: number,
  status: "pending" | "in_progress" | "done" | "skipped",
  performedBy: number | null,
) {
  const { rows: existing } = await client.query(`select * from project_milestones where id = $1`, [milestoneId]);
  if (existing.length === 0) throw new MilestoneNotFoundError(milestoneId);
  const { rows } = await client.query(
    `update project_milestones
     set status = $2, actual_date = case when $2 = 'done' then coalesce(actual_date, current_date) else actual_date end
     where id = $1
     returning *`,
    [milestoneId, status],
  );
  await logProjectActivity(client, existing[0].project_id, performedBy, "milestone_status_changed", { milestoneId, status });
  return rows[0];
}

export async function listMilestones(projectId: number) {
  const { rows } = await query(
    `select * from project_milestones where project_id = $1 order by target_date asc nulls last, id asc`,
    [projectId],
  );
  return rows;
}

export type CreateTaskInput = {
  taskName: string;
  milestoneId?: number | null;
  assigneeId?: number | null;
  dueDate?: string | null;
};

export async function createTask(client: PgClient, projectId: number, input: CreateTaskInput, performedBy: number | null) {
  await assertProjectExists(client, projectId);
  if (input.milestoneId) {
    const { rows: milestoneRows } = await client.query(`select project_id from project_milestones where id = $1`, [input.milestoneId]);
    if (milestoneRows.length === 0) throw new MilestoneNotFoundError(input.milestoneId);
    if (Number(milestoneRows[0].project_id) !== projectId) throw new MilestoneWrongProjectError(input.milestoneId, projectId);
  }
  const { rows } = await client.query(
    `insert into project_tasks (project_id, milestone_id, task_name, assignee_id, due_date)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [projectId, input.milestoneId ?? null, input.taskName, input.assigneeId ?? null, input.dueDate ?? null],
  );
  await logProjectActivity(client, projectId, performedBy, "task_created", { taskName: input.taskName });
  return rows[0];
}

export async function updateTaskStatus(
  client: PgClient,
  taskId: number,
  status: "pending" | "in_progress" | "done" | "cancelled",
  performedBy: number | null,
) {
  const { rows: existing } = await client.query(`select * from project_tasks where id = $1`, [taskId]);
  if (existing.length === 0) throw new TaskNotFoundError(taskId);
  const { rows } = await client.query(
    `update project_tasks set status = $2 where id = $1 returning *`,
    [taskId, status],
  );
  await logProjectActivity(client, existing[0].project_id, performedBy, "task_status_changed", { taskId, status });
  return rows[0];
}

export async function listTasks(projectId: number, milestoneId?: number) {
  const params: unknown[] = [projectId];
  let where = `where project_id = $1`;
  if (milestoneId) {
    params.push(milestoneId);
    where += ` and milestone_id = $2`;
  }
  const { rows } = await query(
    `select t.*, e.employee_name as assignee_name
     from project_tasks t
     left join employees e on e.id = t.assignee_id
     ${where}
     order by t.due_date asc nulls last, t.id asc`,
    params,
  );
  return rows;
}
