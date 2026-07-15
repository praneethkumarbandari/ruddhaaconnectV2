import type { PgClient } from "../db/pool.ts";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";
import { resolveNextApprovalLevel, isEntitledApprover } from "./approvals.ts";
import { employeeHasPermission } from "./rbac-permissions.ts";

const HIERARCHY_CODE = "HR_REIMBURSEMENT_APPROVAL";

export class ClaimNotFoundError extends Error {
  constructor(id: number) { super(`Reimbursement claim ${id} not found.`); this.name = "ClaimNotFoundError"; }
}
export class ClaimNotPendingError extends Error {
  constructor(id: number, status: string) { super(`Claim ${id} is '${status}' — only a 'pending' claim can be acted on.`); this.name = "ClaimNotPendingError"; }
}
export class NotEntitledClaimApproverError extends Error {
  constructor() { super("You are not the entitled approver for this claim at its current level."); this.name = "NotEntitledClaimApproverError"; }
}
export class NotOwnClaimError extends Error {
  constructor() { super("You can only act on your own reimbursement claims. HR staff with payroll.manage can act on an employee's behalf."); this.name = "NotOwnClaimError"; }
}

export type CreateClaimInput = {
  employeeId: number;
  claimType: string;
  amount: number;
  isTaxable: boolean;
  claimDate: string;
  description?: string | null;
};

export async function createClaim(actorUserId: number | null, input: CreateClaimInput) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into reimbursement_claims (employee_id, claim_type, amount, is_taxable, claim_date, description, requested_by)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [input.employeeId, input.claimType, input.amount, input.isTaxable, input.claimDate, input.description ?? null, actorUserId],
    );
    await writeAudit(client, { userId: actorUserId, action: "create", module: "reimbursement_claims", recordId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
}

async function loadPendingClaim(client: PgClient, claimId: number) {
  const { rows } = await client.query(`select * from reimbursement_claims where id = $1`, [claimId]);
  if (rows.length === 0) throw new ClaimNotFoundError(claimId);
  if (rows[0].status !== "pending") throw new ClaimNotPendingError(claimId, rows[0].status);
  return rows[0];
}

export async function approveClaim(actorUserId: number, claimId: number) {
  return withTransaction(async (client) => {
    const claim = await loadPendingClaim(client, claimId);

    const level = await resolveNextApprovalLevel(HIERARCHY_CODE, claim.employee_id, claim.current_level_order - 1);
    if (level) {
      const entitled = await isEntitledApprover(client, actorUserId, level);
      if (!entitled) throw new NotEntitledClaimApproverError();
      if (!level.isFinalLevel) {
        // FIX: same bug as approveCorrectionRequest/approveLeaveRequest —
        // `level` is the level just approved; advancing must resolve the
        // level AFTER it, not reuse level.levelOrder (the same level
        // again), or a claim approved at a non-final level never
        // actually progresses to the next approver.
        const nextLevel = await resolveNextApprovalLevel(HIERARCHY_CODE, claim.employee_id, level.levelOrder);
        if (nextLevel) {
          const { rows } = await client.query(`update reimbursement_claims set current_level_order = $2, updated_at = now() where id = $1 returning *`, [claimId, nextLevel.levelOrder]);
          await writeAudit(client, { userId: actorUserId, action: "update", module: "reimbursement_claims", recordId: claimId, oldValue: claim, newValue: rows[0] });
          return rows[0];
        }
        // No level actually follows a non-final level — treat as complete
        // rather than stranding the request (same fallback as attendance
        // corrections).
      }
    }

    const { rows } = await client.query(
      `update reimbursement_claims set status = 'approved', decided_by = $2, decided_at = now(), updated_at = now() where id = $1 returning *`,
      [claimId, actorUserId],
    );
    await writeAudit(client, { userId: actorUserId, action: "update", module: "reimbursement_claims", recordId: claimId, oldValue: claim, newValue: rows[0] });
    return rows[0];
  });
}

export async function rejectClaim(actorUserId: number, claimId: number, decisionNotes: string | null) {
  return withTransaction(async (client) => {
    const claim = await loadPendingClaim(client, claimId);
    const level = await resolveNextApprovalLevel(HIERARCHY_CODE, claim.employee_id, claim.current_level_order - 1);
    if (level) {
      const entitled = await isEntitledApprover(client, actorUserId, level);
      if (!entitled) throw new NotEntitledClaimApproverError();
    }
    const { rows } = await client.query(
      `update reimbursement_claims set status = 'rejected', decided_by = $2, decided_at = now(), decision_notes = $3, updated_at = now() where id = $1 returning *`,
      [claimId, actorUserId, decisionNotes ?? null],
    );
    await writeAudit(client, { userId: actorUserId, action: "update", module: "reimbursement_claims", recordId: claimId, oldValue: claim, newValue: rows[0] });
    return rows[0];
  });
}

/**
 * Cancellation before any decision — same ownership-or-override
 * authorization gap class Milestone 4 found and fixed for leave
 * cancellation, applied here from the start rather than
 * re-discovering it a third time.
 */
export async function cancelClaim(actorUserId: number, claimId: number) {
  return withTransaction(async (client) => {
    const claim = await loadPendingClaim(client, claimId);
    if (Number(claim.employee_id) !== actorUserId) {
      const isManager = await employeeHasPermission(actorUserId, "payroll.manage");
      if (!isManager) throw new NotOwnClaimError();
    }
    const { rows } = await client.query(`update reimbursement_claims set status = 'rejected', decided_by = $2, decided_at = now(), decision_notes = 'Cancelled by requester', updated_at = now() where id = $1 returning *`, [claimId, actorUserId]);
    await writeAudit(client, { userId: actorUserId, action: "cancel", module: "reimbursement_claims", recordId: claimId, oldValue: claim, newValue: rows[0] });
    return rows[0];
  });
}

export async function getClaim(claimId: number) {
  const { rows } = await query(`select * from reimbursement_claims where id = $1`, [claimId]);
  if (rows.length === 0) throw new ClaimNotFoundError(claimId);
  return rows[0];
}

export async function listClaims(filters: { employeeId?: number; status?: string }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.employeeId) { params.push(filters.employeeId); conditions.push(`employee_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(`select * from reimbursement_claims ${where} order by claim_date desc`, params);
  return rows;
}
