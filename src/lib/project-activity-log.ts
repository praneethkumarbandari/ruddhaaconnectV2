import type { PgClient } from "../db/pool.ts";
import { pool, query } from "../db/pool.ts";

/**
 * Activity Log Service.
 *
 * Deliberately not exposed as its own set of write endpoints — per the
 * frozen Phase 3 design, this is an internal helper called *by* other
 * Project Management services as a side effect of a real mutation
 * (create project, approve budget, add member, etc.), the same way
 * Accounting's own audit_log is written as a side effect rather than
 * its own API. Only a read endpoint exists for it.
 *
 * Records only Project Management events — never an accounting action
 * (that remains audit_log's exclusive concern; the two logs are never
 * merged, per Phase 2's explicit rejection of that coupling).
 */
export async function logProjectActivity(
  client: PgClient,
  projectId: number,
  performedBy: number | null,
  action: string,
  detail: Record<string, unknown> = {},
) {
  await client.query(
    `insert into project_activity_log (project_id, performed_by, action, detail)
     values ($1, $2, $3, $4)`,
    [projectId, performedBy, action, JSON.stringify(detail)],
  );
}

export async function listProjectActivity(projectId: number) {
  const { rows } = await query(
    `select pal.*, e.employee_name
     from project_activity_log pal
     left join employees e on e.id = pal.performed_by
     where pal.project_id = $1
     order by pal.performed_at desc`,
    [projectId],
  );
  return rows;
}
