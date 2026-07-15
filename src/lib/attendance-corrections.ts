import type { PgClient } from "../db/pool.ts";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";
import { upsertAttendanceRecord } from "./attendance.ts";
import { resolveNextApprovalLevel, isEntitledApprover, NoReportingManagerError, HierarchyNotFoundError } from "./approvals.ts";

const HIERARCHY_CODE = "HR_ATTENDANCE_CORRECTION";

export class CorrectionRequestNotFoundError extends Error {
  constructor(id: number) {
    super(`Attendance correction request ${id} not found.`);
    this.name = "CorrectionRequestNotFoundError";
  }
}
export class CorrectionNotPendingError extends Error {
  constructor(id: number, status: string) {
    super(`Correction request ${id} is '${status}' — only a 'pending' request can be acted on.`);
    this.name = "CorrectionNotPendingError";
  }
}
export class NotEntitledApproverError extends Error {
  constructor() {
    super("You are not the entitled approver for this correction request at its current level.");
    this.name = "NotEntitledApproverError";
  }
}

export type CreateCorrectionInput = {
  employeeId: number;
  attendanceDate: string;
  requestedInTimestamp: string | null;
  requestedOutTimestamp: string | null;
  reason: string;
};

/**
 * "Employee -> Attendance Correction Request" — the request itself is
 * a plain insert (no approval framework involvement yet; there's
 * nothing to approve until a request exists). Resolving the first
 * approver happens in approve()/reject(), not here, so creating a
 * request never fails because of an org-chart gap — only ACTING on it
 * does, at the point where that gap actually matters.
 */
export async function createCorrectionRequest(actorUserId: number | null, input: CreateCorrectionInput) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into attendance_correction_requests (employee_id, attendance_date, requested_in_timestamp, requested_out_timestamp, reason, requested_by)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [input.employeeId, input.attendanceDate, input.requestedInTimestamp, input.requestedOutTimestamp, input.reason, actorUserId],
    );
    await writeAudit(client, { userId: actorUserId, action: "create", module: "attendance_correction_requests", recordId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
}

async function loadPendingRequest(client: PgClient, requestId: number) {
  const { rows } = await client.query(`select * from attendance_correction_requests where id = $1`, [requestId]);
  if (rows.length === 0) throw new CorrectionRequestNotFoundError(requestId);
  if (rows[0].status !== "pending") throw new CorrectionNotPendingError(requestId, rows[0].status);
  return rows[0];
}

/**
 * Approves the request at its current level. If more levels remain,
 * advances current_level_order and stays 'pending' for the next
 * approver. If this was the final level, applies the correction —
 * via upsertAttendanceRecord(), the SAME single write path import
 * commit and manual entry use, with source='correction' — and marks
 * the request 'applied'. "No direct database updates" is enforced by
 * this being the only function in the codebase that can move a
 * request to 'applied', and it never writes to attendance_records
 * except through that one shared function.
 */
export async function approveCorrectionRequest(actorUserId: number, requestId: number) {
  return withTransaction(async (client) => {
    const request = await loadPendingRequest(client, requestId);

    let level;
    try {
      level = await resolveNextApprovalLevel(HIERARCHY_CODE, request.employee_id, request.current_level_order - 1);
    } catch (err) {
      if (err instanceof NoReportingManagerError || err instanceof HierarchyNotFoundError) throw err;
      throw err;
    }
    if (!level) {
      // No levels configured at all — treat as auto-approved at
      // whatever level we're on, applying immediately. A tenant that
      // deletes every level from this hierarchy is choosing "no
      // approval required," not creating a stuck state.
      return applyCorrection(client, actorUserId, request);
    }

    const entitled = await isEntitledApprover(client, actorUserId, level);
    if (!entitled) throw new NotEntitledApproverError();

    if (level.isFinalLevel) {
      return applyCorrection(client, actorUserId, request);
    }

    // FIX: `level` is the level that was JUST approved (level 1 here,
    // for example) — advancing must move to the level AFTER it, not
    // reuse level.levelOrder, which is the same level again. Doing
    // that meant a request approved at level 1 never actually moved
    // to level 2: current_level_order got set right back to 1, so
    // the next approval attempt re-resolved and re-checked level 1
    // instead of progressing the workflow.
    const nextLevel = await resolveNextApprovalLevel(HIERARCHY_CODE, request.employee_id, level.levelOrder);
    if (!nextLevel) {
      // Approved level was configured as non-final but no level
      // actually follows it — treat as complete rather than stranding
      // the request at a level_order nothing will ever resolve past.
      return applyCorrection(client, actorUserId, request);
    }

    const { rows } = await client.query(
      `update attendance_correction_requests set current_level_order = $2, updated_at = now() where id = $1 returning *`,
      [requestId, nextLevel.levelOrder],
    );
    await writeAudit(client, { userId: actorUserId, action: "update", module: "attendance_correction_requests", recordId: requestId, oldValue: request, newValue: rows[0] });
    return rows[0];
  });
}

async function applyCorrection(client: PgClient, actorUserId: number, request: { id: number; employee_id: number; attendance_date: string; requested_in_timestamp: string | null; requested_out_timestamp: string | null }) {
  await upsertAttendanceRecord(client, actorUserId, {
    employeeId: request.employee_id,
    attendanceDate: request.attendance_date,
    inTimestamp: request.requested_in_timestamp,
    outTimestamp: request.requested_out_timestamp,
    source: "correction",
  });

  const { rows } = await client.query(
    `update attendance_correction_requests set status = 'applied', decided_by = $2, decided_at = now(), updated_at = now() where id = $1 returning *`,
    [request.id, actorUserId],
  );
  await writeAudit(client, { userId: actorUserId, action: "update", module: "attendance_correction_requests", recordId: request.id, newValue: rows[0] });
  return rows[0];
}

export async function rejectCorrectionRequest(actorUserId: number, requestId: number, decisionNotes: string | null) {
  return withTransaction(async (client) => {
    const request = await loadPendingRequest(client, requestId);

    const level = await resolveNextApprovalLevel(HIERARCHY_CODE, request.employee_id, request.current_level_order - 1);
    if (level) {
      const entitled = await isEntitledApprover(client, actorUserId, level);
      if (!entitled) throw new NotEntitledApproverError();
    }

    const { rows } = await client.query(
      `update attendance_correction_requests set status = 'rejected', decided_by = $2, decided_at = now(), decision_notes = $3, updated_at = now() where id = $1 returning *`,
      [requestId, actorUserId, decisionNotes ?? null],
    );
    await writeAudit(client, { userId: actorUserId, action: "update", module: "attendance_correction_requests", recordId: requestId, oldValue: request, newValue: rows[0] });
    return rows[0];
  });
}

export async function getCorrectionRequest(id: number) {
  const { rows } = await query(`select * from attendance_correction_requests where id = $1`, [id]);
  if (rows.length === 0) throw new CorrectionRequestNotFoundError(id);
  return rows[0];
}

export async function listCorrectionRequests(filters: { employeeId?: number; status?: string }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.employeeId) { params.push(filters.employeeId); conditions.push(`employee_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(`select * from attendance_correction_requests ${where} order by created_at desc`, params);
  return rows;
}
