import type { PgClient } from "../db/pool.ts";
import { pool, query } from "../db/pool.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { logProjectActivity } from "./project-activity-log.ts";

/**
 * Budget Service.
 *
 * project_budget_versions / project_budget hold planning targets only
 * — budgeted_amount is a target the user entered, never a computed
 * actual. "Actual" figures are Reporting Service's exclusive concern
 * (Batch 3), derived live from Accounting; this file never queries
 * journal_entries or any of the six tagged document tables.
 */

export class BudgetVersionNotFoundError extends Error {
  constructor(id: number) { super(`Budget version ${id} not found.`); this.name = "BudgetVersionNotFoundError"; }
}
export class AnotherVersionApprovedError extends Error {
  constructor(projectId: number) {
    super(`Project ${projectId} already has an approved budget version. Supersede it before approving another.`);
    this.name = "AnotherVersionApprovedError";
  }
}
export class BudgetVersionNotDraftError extends Error {
  constructor(id: number, status: string) {
    super(`Budget version ${id} is '${status}' — only a 'draft' version can be approved.`);
    this.name = "BudgetVersionNotDraftError";
  }
}
export class InvalidBudgetLineError extends Error {
  constructor(reason: string) { super(reason); this.name = "InvalidBudgetLineError"; }
}

async function assertProjectExists(client: PgClient, projectId: number) {
  const { rows } = await client.query(`select id from projects where id = $1`, [projectId]);
  if (rows.length === 0) throw new ProjectNotFoundError(projectId);
}

export class BudgetVersionNumberConflictError extends Error {
  constructor(projectId: number) {
    super(`Could not allocate a unique budget version number for project ${projectId} after repeated attempts. Please try again.`);
    this.name = "BudgetVersionNumberConflictError";
  }
}

export async function createBudgetVersion(client: PgClient, projectId: number, performedBy: number | null) {
  await assertProjectExists(client, projectId);

  // FIX: version_no was computed via max()+1 with no row lock, so
  // concurrent creates for the same project could compute the same
  // next version number. Confirmed live: 5/10 concurrent requests
  // failed with a raw "duplicate key value violates unique constraint"
  // error, which isn't a recognized domain error class and would have
  // surfaced as a generic, unhelpful 500 to the caller.
  //
  // A first attempt at fixing this just retried the SELECT+INSERT on
  // the same client after a failure — confirmed live that this doesn't
  // work: Postgres poisons the entire transaction after any statement
  // fails, so every retry attempt failed with "current transaction is
  // aborted, commands ignored until end of transaction block." This
  // function receives an externally-managed client (it participates in
  // whatever transaction its caller opened), so it can't just open a
  // fresh transaction per attempt the way inventory.ts's
  // createInventoryItem does. A SAVEPOINT is the correct tool here:
  // it lets one attempt fail and roll back to a clean point without
  // poisoning the caller's outer transaction.
  const MAX_ATTEMPTS = 15;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await client.query(`savepoint create_budget_version_attempt`);
    const { rows: maxRows } = await client.query(
      `select coalesce(max(version_no), 0) as max_version from project_budget_versions where project_id = $1`,
      [projectId],
    );
    const nextVersion = Number(maxRows[0].max_version) + 1;

    try {
      const { rows } = await client.query(
        `insert into project_budget_versions (project_id, version_no, status) values ($1, $2, 'draft') returning *`,
        [projectId, nextVersion],
      );
      await client.query(`release savepoint create_budget_version_attempt`);
      await logProjectActivity(client, projectId, performedBy, "budget_version_created", { versionNo: nextVersion });
      return rows[0];
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505" && attempt < MAX_ATTEMPTS) {
        await client.query(`rollback to savepoint create_budget_version_attempt`);
        continue;
      }
      // Found during review: on exhaustion this used to re-throw the
      // raw Postgres error, unlike inventory's equivalent fix, which
      // wraps its own exhaustion case in a real domain error. Matching
      // that here — same reasoning: real (if practically unreachable,
      // given 15 attempts and a proven 25-concurrent success rate),
      // and a clean 409 beats an unhelpful generic 500.
      if (pgErr.code === "23505") {
        await client.query(`rollback to savepoint create_budget_version_attempt`);
        throw new BudgetVersionNumberConflictError(projectId);
      }
      throw err;
    }
  }
  throw new BudgetVersionNumberConflictError(projectId);
}

export type BudgetLineInput = {
  accountCode?: string | null;
  categoryLabel?: string | null;
  budgetType: "cost" | "revenue";
  budgetedAmount: number;
};

export async function addBudgetLine(client: PgClient, budgetVersionId: number, line: BudgetLineInput) {
  const { rows: versionRows } = await client.query(`select * from project_budget_versions where id = $1`, [budgetVersionId]);
  if (versionRows.length === 0) throw new BudgetVersionNotFoundError(budgetVersionId);
  if (versionRows[0].status !== "draft") {
    throw new InvalidBudgetLineError(`Cannot add a line to budget version ${budgetVersionId} — it is '${versionRows[0].status}', not 'draft'.`);
  }
  if (!line.accountCode && !line.categoryLabel) {
    throw new InvalidBudgetLineError("Either accountCode or categoryLabel is required for a budget line.");
  }
  if (line.budgetedAmount < 0) {
    throw new InvalidBudgetLineError("budgetedAmount cannot be negative.");
  }

  const { rows } = await client.query(
    `insert into project_budget (budget_version_id, account_code, category_label, budget_type, budgeted_amount)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [budgetVersionId, line.accountCode ?? null, line.categoryLabel ?? null, line.budgetType, line.budgetedAmount],
  );
  return rows[0];
}

export async function approveBudgetVersion(client: PgClient, budgetVersionId: number, performedBy: number | null) {
  const { rows: versionRows } = await client.query(`select * from project_budget_versions where id = $1`, [budgetVersionId]);
  if (versionRows.length === 0) throw new BudgetVersionNotFoundError(budgetVersionId);
  const version = versionRows[0];
  if (version.status !== "draft") throw new BudgetVersionNotDraftError(budgetVersionId, version.status);

  const { rows: existingApproved } = await client.query(
    `select id from project_budget_versions where project_id = $1 and status = 'approved'`,
    [version.project_id],
  );
  if (existingApproved.length > 0) throw new AnotherVersionApprovedError(version.project_id);

  const { rows } = await client.query(
    `update project_budget_versions set status = 'approved', approved_by = $2, approved_at = now() where id = $1 returning *`,
    [budgetVersionId, performedBy],
  );
  await logProjectActivity(client, version.project_id, performedBy, "budget_version_approved", { budgetVersionId });
  return rows[0];
}

/**
 * Supersede the currently-approved version — this is the *only* way a
 * new version can ever be approved for a project (never overwrite,
 * only supersede, matching the principle already established for
 * accounting reversals and Knowledge Base entities).
 */
export async function supersedeBudgetVersion(client: PgClient, budgetVersionId: number, performedBy: number | null) {
  const { rows: versionRows } = await client.query(`select * from project_budget_versions where id = $1`, [budgetVersionId]);
  if (versionRows.length === 0) throw new BudgetVersionNotFoundError(budgetVersionId);
  const version = versionRows[0];
  if (version.status !== "approved") {
    throw new InvalidBudgetLineError(`Cannot supersede budget version ${budgetVersionId} — it is '${version.status}', not 'approved'.`);
  }
  const { rows } = await client.query(
    `update project_budget_versions set status = 'superseded' where id = $1 returning *`,
    [budgetVersionId],
  );
  await logProjectActivity(client, version.project_id, performedBy, "budget_version_superseded", { budgetVersionId });
  return rows[0];
}

export async function listBudgetVersions(projectId: number) {
  const { rows } = await query(
    `select * from project_budget_versions where project_id = $1 order by version_no desc`,
    [projectId],
  );
  return rows;
}

export async function getBudgetVersionWithLines(budgetVersionId: number) {
  const { rows: versionRows } = await query(`select * from project_budget_versions where id = $1`, [budgetVersionId]);
  if (versionRows.length === 0) throw new BudgetVersionNotFoundError(budgetVersionId);
  const { rows: lines } = await query(
    `select * from project_budget where budget_version_id = $1 order by id asc`,
    [budgetVersionId],
  );
  return { ...versionRows[0], lines };
}
