import type { PgClient } from "../db/pool.ts";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";
import { assertNotLocked } from "./attendance-locks.ts";
import { assertWithinEmployment, getEmployeeAssignmentSnapshot, getStatusIdByCode } from "./attendance.ts";
import { isHoliday, isWeeklyOff } from "./attendance-processing.ts";
import { resolveNextApprovalLevel, isEntitledApprover } from "./approvals.ts";
import { employeeHasPermission } from "./rbac-permissions.ts";
import { getLeavePolicy, getLeaveYearForDate, getLeaveBalance, postLeaveBalanceTransaction, InsufficientLeaveBalanceError } from "./leave-balance.ts";

const HIERARCHY_CODE = "HR_LEAVE_APPROVAL";

export class LeaveRequestNotFoundError extends Error {
  constructor(id: number) { super(`Leave request ${id} not found.`); this.name = "LeaveRequestNotFoundError"; }
}
export class LeaveNotPendingError extends Error {
  constructor(id: number, status: string) { super(`Leave request ${id} is '${status}' — only a 'pending' request can be acted on.`); this.name = "LeaveNotPendingError"; }
}
export class LeaveNotCancellableError extends Error {
  constructor(id: number, status: string) { super(`Leave request ${id} is '${status}' and cannot be cancelled.`); this.name = "LeaveNotCancellableError"; }
}
export class NotEntitledLeaveApproverError extends Error {
  constructor() { super("You are not the entitled approver for this leave request at its current level."); this.name = "NotEntitledLeaveApproverError"; }
}
export class OverlappingLeaveError extends Error {
  constructor() { super("This date range overlaps an existing pending or approved leave request."); this.name = "OverlappingLeaveError"; }
}
export class InvalidHalfDayRequestError extends Error {
  constructor(reason: string) { super(`Invalid half-day request: ${reason}`); this.name = "InvalidHalfDayRequestError"; }
}
export class MaxConsecutiveLeaveExceededError extends Error {
  constructor(requested: number, max: number) { super(`Requested ${requested} day(s) exceeds the maximum of ${max} consecutive day(s) allowed for this leave type.`); this.name = "MaxConsecutiveLeaveExceededError"; }
}
export class LeaveNotAllowedDuringProbationError extends Error {
  constructor() { super("This leave type is not available during the probation period."); this.name = "LeaveNotAllowedDuringProbationError"; }
}
export class LeaveRestrictedDuringNoticeError extends Error {
  constructor() { super("This leave type is restricted while serving notice period."); this.name = "LeaveRestrictedDuringNoticeError"; }
}
export class PastDateLeaveError extends Error {
  constructor() { super("Leave cannot be requested for a date in the past."); this.name = "PastDateLeaveError"; }
}
export class EmptyLeaveRangeError extends Error {
  constructor() { super("The requested date range contains no days that would count as leave (all holidays/weekly-offs, and the sandwich rule doesn't apply)."); this.name = "EmptyLeaveRangeError"; }
}

/**
 * Normalizes a value that should be an ISO 'YYYY-MM-DD' date string but
 * may arrive as a JS Date object instead — which is exactly what the
 * `pg` driver hands back for a Postgres `date` column. Some callers of
 * enumerateDates() pass request-body strings (already safe); others
 * (applyLeaveToAttendance, request cancellation) pass a raw DB row's
 * from_date/to_date straight from `select *`, which are Date objects.
 * Without this, `${fromDate}T00:00:00Z` silently stringifies the Date
 * via its verbose .toString() instead of an ISO date, producing a
 * value `new Date(...)` can't parse — this previously broke leave
 * approval and cancellation for any request fetched from the DB.
 */
function toIsoDateString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

function enumerateDates(fromDate: string | Date, toDate: string | Date): string[] {
  const fromIso = toIsoDateString(fromDate);
  const toIso = toIsoDateString(toDate);
  const dates: string[] = [];
  const cursor = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Computes how many days a [fromDate, toDate] range actually counts
 * against leave balance. Half-day is a direct 0.5 (validated
 * elsewhere that fromDate === toDate for a half-day request).
 * Otherwise: every 'workday' counts; a holiday counts only if
 * policy.count_holidays_as_leave; a weekly-off never counts on its
 * own. If policy.sandwich_rule_enabled, any holiday/weekly-off day
 * strictly INSIDE the range (not the very first or very last date)
 * counts too — it is, by definition of being interior to a single
 * contiguous request, bridged by days on both sides within this same
 * request. This does NOT look at adjacent, separate leave requests
 * (e.g. leave ending Friday, then a new request starting Monday) —
 * that cross-request sandwich case is a known, documented scope
 * boundary (see the Milestone 4 doc), not silently guessed at.
 */
export async function calculateLeaveDayCount(
  client: PgClient,
  employeeId: number,
  fromDate: string,
  toDate: string,
  isHalfDay: boolean,
  policy: { sandwich_rule_enabled: boolean; count_holidays_as_leave: boolean },
): Promise<number> {
  if (isHalfDay) return 0.5;

  const dates = enumerateDates(fromDate, toDate);
  const categories: Array<"workday" | "holiday" | "weekly_off"> = [];
  for (const d of dates) {
    if (await isHoliday(client, employeeId, d)) categories.push("holiday");
    else if (await isWeeklyOff(client, employeeId, d)) categories.push("weekly_off");
    else categories.push("workday");
  }

  const counted = categories.map((c) => c === "workday" || (c === "holiday" && policy.count_holidays_as_leave));

  if (policy.sandwich_rule_enabled) {
    for (let i = 1; i < categories.length - 1; i++) {
      if (categories[i] !== "workday" && !counted[i]) counted[i] = true;
    }
  }

  return counted.filter(Boolean).length;
}

export type CreateLeaveRequestInput = {
  employeeId: number;
  leaveTypeId: number;
  fromDate: string;
  toDate: string;
  isHalfDay: boolean;
  halfDaySession?: "first_half" | "second_half" | null;
  reason: string;
};

export async function createLeaveRequest(actorUserId: number | null, input: CreateLeaveRequestInput) {
  return withTransaction(async (client) => {
    const today = new Date().toISOString().slice(0, 10);
    if (input.fromDate < today) throw new PastDateLeaveError();

    await assertWithinEmployment(client, input.employeeId, input.fromDate);
    await assertWithinEmployment(client, input.employeeId, input.toDate);
    await assertNotLocked(client, input.fromDate);
    await assertNotLocked(client, input.toDate);

    if (input.isHalfDay && input.fromDate !== input.toDate) {
      throw new InvalidHalfDayRequestError("a half-day request must have the same fromDate and toDate.");
    }

    const policy = await getLeavePolicy(client, input.leaveTypeId);
    if (input.isHalfDay && !policy.half_day_enabled) {
      throw new InvalidHalfDayRequestError(`half-day is not permitted for leave type '${policy.leave_type_name}'.`);
    }

    // Probation / notice-period policy restrictions
    const { rows: masterRows } = await client.query(`select joining_date, exit_date from employee_master where employee_id = $1`, [input.employeeId]);
    const joiningDate = masterRows[0]?.joining_date ? String(masterRows[0].joining_date).slice(0, 10) : null;
    const exitDate = masterRows[0]?.exit_date ? String(masterRows[0].exit_date).slice(0, 10) : null;
    if (joiningDate && policy.probation_period_days > 0 && !policy.allow_during_probation) {
      const probationEnd = new Date(`${joiningDate}T00:00:00Z`);
      probationEnd.setUTCDate(probationEnd.getUTCDate() + policy.probation_period_days);
      if (input.fromDate <= probationEnd.toISOString().slice(0, 10)) throw new LeaveNotAllowedDuringProbationError();
    }
    if (exitDate && policy.notice_period_restricted) {
      // Being on notice is modeled as "exit_date is set" — the same
      // signal HR M2 uses. Any leave request touching a date on or
      // after exit_date is already blocked by assertWithinEmployment;
      // this additionally blocks requests made WHILE serving notice
      // even for dates still before exit_date, when the policy says so.
      throw new LeaveRestrictedDuringNoticeError();
    }

    const dayCount = await calculateLeaveDayCount(client, input.employeeId, input.fromDate, input.toDate, input.isHalfDay, policy);
    if (dayCount <= 0) throw new EmptyLeaveRangeError();

    if (policy.max_consecutive_days != null && dayCount > Number(policy.max_consecutive_days)) {
      throw new MaxConsecutiveLeaveExceededError(dayCount, Number(policy.max_consecutive_days));
    }

    if (policy.requires_balance_check) {
      const leaveYear = await getLeaveYearForDate(client, input.fromDate);
      const balance = await getLeaveBalance(client, input.employeeId, input.leaveTypeId, leaveYear);
      if (balance < dayCount) throw new InsufficientLeaveBalanceError(balance, dayCount);
    }

    // Overlap / duplicate-pending check. The partial unique index on
    // (employee_id, from_date, to_date) where status='pending' only
    // catches an EXACT date-range repeat; a genuine overlap check
    // (any intersection, not just an identical range) needs an
    // explicit query.
    const { rows: overlapping } = await client.query(
      `select 1 from leave_requests
       where employee_id = $1 and status in ('pending', 'approved')
         and from_date <= $3 and to_date >= $2
       limit 1`,
      [input.employeeId, input.fromDate, input.toDate],
    );
    if (overlapping.length > 0) throw new OverlappingLeaveError();

    try {
      const { rows } = await client.query(
        `insert into leave_requests (employee_id, leave_type_id, from_date, to_date, is_half_day, half_day_session, day_count, reason, requested_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [input.employeeId, input.leaveTypeId, input.fromDate, input.toDate, input.isHalfDay, input.halfDaySession ?? null, dayCount, input.reason, actorUserId],
      );
      await writeAudit(client, { userId: actorUserId, action: "create", module: "leave_requests", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new OverlappingLeaveError();
      throw err;
    }
  });
}

async function loadPendingRequest(client: PgClient, requestId: number) {
  const { rows } = await client.query(`select * from leave_requests where id = $1`, [requestId]);
  if (rows.length === 0) throw new LeaveRequestNotFoundError(requestId);
  if (rows[0].status !== "pending") throw new LeaveNotPendingError(requestId, rows[0].status);
  return rows[0];
}

export async function approveLeaveRequest(actorUserId: number, requestId: number) {
  return withTransaction(async (client) => {
    const request = await loadPendingRequest(client, requestId);

    const level = await resolveNextApprovalLevel(HIERARCHY_CODE, request.employee_id, request.current_level_order - 1);
    if (!level) return finalizeLeaveApproval(client, actorUserId, request);

    const entitled = await isEntitledApprover(client, actorUserId, level);
    if (!entitled) throw new NotEntitledLeaveApproverError();

    if (level.isFinalLevel) return finalizeLeaveApproval(client, actorUserId, request);

    // FIX: same bug as attendance corrections' approveCorrectionRequest —
    // `level` is the level just approved; advancing must resolve the
    // level AFTER it, not reuse level.levelOrder (the same level again),
    // or a multi-level leave approval never progresses past level 1.
    const nextLevel = await resolveNextApprovalLevel(HIERARCHY_CODE, request.employee_id, level.levelOrder);
    if (!nextLevel) return finalizeLeaveApproval(client, actorUserId, request);

    const { rows } = await client.query(
      `update leave_requests set current_level_order = $2, updated_at = now() where id = $1 returning *`,
      [requestId, nextLevel.levelOrder],
    );
    await writeAudit(client, { userId: actorUserId, action: "update", module: "leave_requests", recordId: requestId, oldValue: request, newValue: rows[0] });
    return rows[0];
  });
}

async function finalizeLeaveApproval(client: PgClient, actorUserId: number, request: any) {
  const policy = await getLeavePolicy(client, request.leave_type_id);
  const leaveYear = await getLeaveYearForDate(client, request.from_date);

  if (policy.requires_balance_check) {
    const balance = await getLeaveBalance(client, request.employee_id, request.leave_type_id, leaveYear);
    if (balance < Number(request.day_count)) throw new InsufficientLeaveBalanceError(balance, Number(request.day_count));
    await postLeaveBalanceTransaction(client, actorUserId, {
      employeeId: request.employee_id, leaveTypeId: request.leave_type_id, leaveYear,
      transactionType: "consumption", days: -Number(request.day_count),
      referenceType: "leave_request", referenceId: request.id,
      remarks: `Leave ${request.from_date} to ${request.to_date}.`,
    });
  }

  await applyLeaveToAttendance(client, actorUserId, request);

  const { rows } = await client.query(
    `update leave_requests set status = 'approved', decided_by = $2, decided_at = now(), updated_at = now() where id = $1 returning *`,
    [request.id, actorUserId],
  );
  await writeAudit(client, { userId: actorUserId, action: "update", module: "leave_requests", recordId: request.id, oldValue: request, newValue: rows[0] });
  return rows[0];
}

/**
 * Writes ON_LEAVE attendance_records for every date in the leave's
 * range that actually counts as a leave day (re-deriving the same set
 * calculateLeaveDayCount used, rather than trusting a stored day list
 * — there isn't one; day_count is a number, not a stored date array,
 * consistent with "derive, don't store"). Deliberately does NOT use
 * upsertAttendanceRecord() (that function is punch-calculation-
 * specific; there's no punch here) — but does reuse its lock check,
 * employment-date check, and snapshot logic via the shared helpers
 * extracted for exactly this purpose.
 *
 * Skips any date that already has a REAL punch (non-null in_timestamp
 * or out_timestamp) — approved leave does not overwrite evidence the
 * employee actually came to work that day. This is a deliberate
 * business-rule choice: leave is authoritative for days with no
 * competing real data, never for days where competing real data exists.
 */
async function applyLeaveToAttendance(client: PgClient, actorUserId: number, request: any) {
  const policy = await getLeavePolicy(client, request.leave_type_id);
  const dates = enumerateDates(request.from_date, request.to_date);
  const statusId = await getStatusIdByCode(client, "ON_LEAVE");
  const snapshot = await getEmployeeAssignmentSnapshot(client, request.employee_id);

  for (const date of dates) {
    const isHol = await isHoliday(client, request.employee_id, date);
    const isWO = await isWeeklyOff(client, request.employee_id, date);
    const countsAsLeaveDay = !isHol && !isWO ? true : (isHol && policy.count_holidays_as_leave) || policy.sandwich_rule_enabled;
    if (!countsAsLeaveDay) continue;

    await assertNotLocked(client, date);

    const { rows: prior } = await client.query(`select * from attendance_records where employee_id = $1 and attendance_date = $2`, [request.employee_id, date]);
    if (prior.length > 0 && (prior[0].in_timestamp || prior[0].out_timestamp)) {
      continue; // real punch data exists — leave does not overwrite it, see function comment
    }

    const { rows: written } = await client.query(
      `insert into attendance_records (employee_id, attendance_date, status_id, source, leave_request_id, is_half_day, department_id, branch_id, cost_center_id)
       values ($1,$2,$3,'leave',$4,$5,$6,$7,$8)
       on conflict (employee_id, attendance_date) do update set
         status_id = excluded.status_id, source = excluded.source, leave_request_id = excluded.leave_request_id,
         is_half_day = excluded.is_half_day, department_id = excluded.department_id, branch_id = excluded.branch_id,
         cost_center_id = excluded.cost_center_id, updated_at = now()
       returning *`,
      [request.employee_id, date, statusId, request.id, request.is_half_day, snapshot.department_id, snapshot.branch_id, snapshot.cost_center_id],
    );
    await writeAudit(client, { userId: actorUserId, action: prior.length > 0 ? "update" : "create", module: "attendance_records", recordId: written[0].id, oldValue: prior[0] ?? undefined, newValue: written[0] });
  }
}

export async function rejectLeaveRequest(actorUserId: number, requestId: number, decisionNotes: string | null) {
  return withTransaction(async (client) => {
    const request = await loadPendingRequest(client, requestId);

    const level = await resolveNextApprovalLevel(HIERARCHY_CODE, request.employee_id, request.current_level_order - 1);
    if (level) {
      const entitled = await isEntitledApprover(client, actorUserId, level);
      if (!entitled) throw new NotEntitledLeaveApproverError();
    }

    const { rows } = await client.query(
      `update leave_requests set status = 'rejected', decided_by = $2, decided_at = now(), decision_notes = $3, updated_at = now() where id = $1 returning *`,
      [requestId, actorUserId, decisionNotes ?? null],
    );
    await writeAudit(client, { userId: actorUserId, action: "update", module: "leave_requests", recordId: requestId, oldValue: request, newValue: rows[0] });
    return rows[0];
  });
}

export class NotOwnLeaveRequestError extends Error {
  constructor() { super("You can only cancel your own leave requests. HR staff with leave.manage can cancel on an employee's behalf."); this.name = "NotOwnLeaveRequestError"; }
}

/**
 * Cancellation. Allowed for 'pending' (no balance/attendance to
 * reverse yet) or 'approved' (must reverse both). Blocked entirely —
 * not partially — if ANY affected date is now locked, requiring HR to
 * unlock first; a partial reversal (some days reverted, others left
 * as ON_LEAVE because they got locked in the meantime) would be a
 * worse, more confusing state than simply refusing the whole
 * cancellation until it can be done cleanly.
 *
 * Ownership check: the route gates this with `leave.apply`, which the
 * EMPLOYEE baseline role holds broadly — the same coarse-permission
 * pattern used for approvals. Without a per-request check here,
 * anyone holding that broad permission could cancel ANY employee's
 * leave request just by knowing its ID, since `leave.apply` says
 * nothing about whose request is being acted on. This function is
 * the actual authorization boundary: the caller must either BE the
 * request's own employee, or hold `leave.manage` (an HR-level
 * override, e.g. cancelling on a departing employee's behalf).
 */
export async function cancelLeaveRequest(actorUserId: number, requestId: number, cancellationReason: string) {
  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(`select * from leave_requests where id = $1`, [requestId]);
    if (existingRows.length === 0) throw new LeaveRequestNotFoundError(requestId);
    const request = existingRows[0];

    if (Number(request.employee_id) !== actorUserId) {
      const isManager = await employeeHasPermission(actorUserId, "leave.manage");
      if (!isManager) throw new NotOwnLeaveRequestError();
    }

    if (!["pending", "approved"].includes(request.status)) throw new LeaveNotCancellableError(requestId, request.status);

    if (request.status === "approved") {
      const dates = enumerateDates(request.from_date, request.to_date);
      for (const date of dates) await assertNotLocked(client, date);

      const { rows: attendanceRows } = await client.query(`select * from attendance_records where leave_request_id = $1`, [requestId]);
      for (const record of attendanceRows) {
        await client.query(`delete from attendance_records where id = $1`, [record.id]);
        await writeAudit(client, { userId: actorUserId, action: "cancel", module: "attendance_records", recordId: record.id, oldValue: record });
      }

      const policy = await getLeavePolicy(client, request.leave_type_id);
      if (policy.requires_balance_check) {
        const leaveYear = await getLeaveYearForDate(client, request.from_date);
        await postLeaveBalanceTransaction(client, actorUserId, {
          employeeId: request.employee_id, leaveTypeId: request.leave_type_id, leaveYear,
          transactionType: "manual_adjustment", days: Number(request.day_count),
          referenceType: "leave_request", referenceId: request.id,
          remarks: `Reversal: cancellation of previously-approved leave ${request.from_date} to ${request.to_date}.`,
        });
      }
    }

    const { rows } = await client.query(
      `update leave_requests set status = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancellation_reason = $3, updated_at = now() where id = $1 returning *`,
      [requestId, actorUserId, cancellationReason],
    );
    await writeAudit(client, { userId: actorUserId, action: "cancel", module: "leave_requests", recordId: requestId, oldValue: request, newValue: rows[0] });
    return rows[0];
  });
}

export async function getLeaveRequest(id: number) {
  const { rows } = await query(
    `select lr.*, e.employee_name, em.employee_code, lt.leave_type_code, lt.leave_type_name
     from leave_requests lr
     join employees e on e.id = lr.employee_id
     join employee_master em on em.employee_id = lr.employee_id
     join leave_types lt on lt.id = lr.leave_type_id
     where lr.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new LeaveRequestNotFoundError(id);
  return rows[0];
}

export async function listLeaveRequests(filters: { employeeId?: number; status?: string; departmentId?: number; dateFrom?: string; dateTo?: string }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.employeeId) { params.push(filters.employeeId); conditions.push(`lr.employee_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); conditions.push(`lr.status = $${params.length}`); }
  if (filters.departmentId) { params.push(filters.departmentId); conditions.push(`em.department_id = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); conditions.push(`lr.to_date >= $${params.length}`); }
  if (filters.dateTo) { params.push(filters.dateTo); conditions.push(`lr.from_date <= $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(
    `select lr.*, e.employee_name, em.employee_code, lt.leave_type_code, lt.leave_type_name
     from leave_requests lr
     join employees e on e.id = lr.employee_id
     join employee_master em on em.employee_id = lr.employee_id
     join leave_types lt on lt.id = lr.leave_type_id
     ${where}
     order by lr.from_date desc`,
    params,
  );
  return rows;
}

/** "Pending Approvals" report: every pending request where `approverEmployeeId` is the entitled approver at its current level. Necessarily one resolution query per pending request — flagged as a scale limit in the Attendance Domain Review (§10) for the identical pattern; unchanged reasoning applies here. */
export async function listMyPendingApprovals(approverEmployeeId: number) {
  const { rows: pending } = await query(
    `select lr.*, e.employee_name, em.employee_code, lt.leave_type_name
     from leave_requests lr
     join employees e on e.id = lr.employee_id
     join employee_master em on em.employee_id = lr.employee_id
     join leave_types lt on lt.id = lr.leave_type_id
     where lr.status = 'pending'
     order by lr.from_date`,
  );

  const mine = [];
  for (const request of pending) {
    try {
      const level = await resolveNextApprovalLevel(HIERARCHY_CODE, request.employee_id, request.current_level_order - 1);
      if (!level) continue;
      const entitled = level.approverType === "reporting_manager"
        ? level.resolvedApproverEmployeeId === approverEmployeeId
        : (await query(`select 1 from user_roles where employee_id = $1 and role_id = $2`, [approverEmployeeId, level.approverRoleId])).rows.length > 0;
      if (entitled) mine.push(request);
    } catch {
      // A requester with no reporting manager (NoReportingManagerError)
      // simply can't be resolved for anyone — correctly excluded from
      // every approver's queue rather than crashing the whole report.
      continue;
    }
  }
  return mine;
}
