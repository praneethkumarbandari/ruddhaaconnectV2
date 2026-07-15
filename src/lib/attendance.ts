import type { PgClient } from "../db/pool.ts";
import { pool, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";
import { assertNotLocked } from "./attendance-locks.ts";
import { getShiftForDate, getPolicyForShift, calculateAttendance, getStatusIdByCode } from "./attendance-processing.ts";

// Re-exported so leave.ts (and any other future consumer) can import
// this from attendance.ts alongside assertWithinEmployment and
// getEmployeeAssignmentSnapshot, instead of also reaching into
// attendance-processing.ts directly for one function. Fixes a broken
// import: leave.ts already imported this name from here, but it was
// never actually re-exported — a pre-existing gap in the original HR
// module code, not a behavior change.
export { getStatusIdByCode };

export class AttendanceRecordNotFoundError extends Error {
  constructor(id: number) {
    super(`Attendance record ${id} not found.`);
    this.name = "AttendanceRecordNotFoundError";
  }
}

export class AttendanceOutsideEmploymentError extends Error {
  constructor(attendanceDate: string, reason: string) {
    super(`Cannot record attendance for ${attendanceDate}: ${reason}`);
    this.name = "AttendanceOutsideEmploymentError";
  }
}

export type UpsertAttendanceInput = {
  employeeId: number;
  attendanceDate: string;
  inTimestamp: string | null;
  outTimestamp: string | null;
  source: "biometric_import" | "manual" | "correction";
  importBatchId?: number | null;
  remarks?: string | null;
};

/**
 * The ONE function that writes to attendance_records — called by
 * import commit (lib/attendance-import.ts), manual entry
 * (routes/attendance/records.ts), and correction application
 * (lib/attendance-corrections.ts). Every one of those callers gets
 * the same lock check and the same calculation logic; there is no
 * second path that writes attendance data with different rules.
 * Must be called with the caller's own transaction client — this
 * function does not open its own transaction, so lock-check +
 * calculation + write are always atomic with whatever the caller is
 * already doing (e.g. also updating an import row's status).
 */
/** Postgres returns `date` columns as JS Date objects via node-pg — normalizes to a plain ISO date string for string comparison against a plain ISO input string. Exported because lib/leave.ts needs the same normalization for its own employment-date checks. */
export function toIsoDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Rejects a date outside an employee's employment period. Originally
 * inline in upsertAttendanceRecord (Attendance Domain Review finding);
 * extracted so lib/leave.ts can apply the identical rule to leave
 * requests without a second, potentially-drifting copy of this check.
 */
export async function assertWithinEmployment(client: PgClient, employeeId: number, date: string): Promise<void> {
  const { rows: masterRows } = await client.query(
    `select joining_date, exit_date from employee_master where employee_id = $1`,
    [employeeId],
  );
  if (masterRows.length === 0) {
    throw new AttendanceOutsideEmploymentError(date, `employee ${employeeId} has no employee_master record.`);
  }
  const { joining_date: joiningDate, exit_date: exitDate } = masterRows[0];
  if (joiningDate && date < toIsoDate(joiningDate)) {
    throw new AttendanceOutsideEmploymentError(date, `it is before the employee's joining date (${toIsoDate(joiningDate)}).`);
  }
  if (exitDate && date > toIsoDate(exitDate)) {
    throw new AttendanceOutsideEmploymentError(date, `it is after the employee's exit date (${toIsoDate(exitDate)}).`);
  }
}

/**
 * The department/branch/cost_center snapshot used by both
 * upsertAttendanceRecord (punch-based records) and, once Leave writes
 * to attendance_records for an approved leave day, lib/leave.ts —
 * same point-in-time-accuracy reasoning as the Attendance Domain
 * Review's original fix, applied consistently rather than
 * re-implemented per caller.
 */
export async function getEmployeeAssignmentSnapshot(client: PgClient, employeeId: number) {
  const { rows } = await client.query(
    `select department_id, branch_id, cost_center_id from employee_master where employee_id = $1`,
    [employeeId],
  );
  return rows[0] ?? { department_id: null, branch_id: null, cost_center_id: null };
}

export async function upsertAttendanceRecord(client: PgClient, actorUserId: number | null, input: UpsertAttendanceInput) {
  await assertNotLocked(client, input.attendanceDate);
  await assertWithinEmployment(client, input.employeeId, input.attendanceDate);

  const shift = await getShiftForDate(client, input.employeeId, input.attendanceDate);
  const policy = await getPolicyForShift(client, shift?.attendancePolicyId ?? null);
  const computed = await calculateAttendance(client, {
    employeeId: input.employeeId,
    attendanceDate: input.attendanceDate,
    inTimestamp: input.inTimestamp,
    outTimestamp: input.outTimestamp,
    shift,
    policy,
  });
  const statusId = await getStatusIdByCode(client, computed.statusCode);
  const snapshot = await getEmployeeAssignmentSnapshot(client, input.employeeId);

  const { rows: existing } = await client.query(
    `select * from attendance_records where employee_id = $1 and attendance_date = $2`,
    [input.employeeId, input.attendanceDate],
  );

  const { rows } = await client.query(
    `insert into attendance_records (
       employee_id, attendance_date, shift_id, in_timestamp, out_timestamp, status_id,
       working_minutes, late_minutes, early_exit_minutes, overtime_minutes, is_half_day,
       source, import_batch_id, department_id, branch_id, cost_center_id, remarks
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     on conflict (employee_id, attendance_date) do update set
       shift_id = excluded.shift_id, in_timestamp = excluded.in_timestamp, out_timestamp = excluded.out_timestamp,
       status_id = excluded.status_id, working_minutes = excluded.working_minutes, late_minutes = excluded.late_minutes,
       early_exit_minutes = excluded.early_exit_minutes, overtime_minutes = excluded.overtime_minutes,
       is_half_day = excluded.is_half_day, source = excluded.source, import_batch_id = excluded.import_batch_id,
       department_id = excluded.department_id, branch_id = excluded.branch_id, cost_center_id = excluded.cost_center_id,
       remarks = excluded.remarks, updated_at = now()
     returning *`,
    [
      input.employeeId, input.attendanceDate, shift?.shiftId ?? null, input.inTimestamp, input.outTimestamp, statusId,
      computed.workingMinutes, computed.lateMinutes, computed.earlyExitMinutes, computed.overtimeMinutes, computed.isHalfDay,
      input.source, input.importBatchId ?? null, snapshot.department_id, snapshot.branch_id, snapshot.cost_center_id, input.remarks ?? null,
    ],
  );

  await writeAudit(client, {
    userId: actorUserId,
    action: existing.length > 0 ? "update" : "create",
    module: "attendance_records",
    recordId: rows[0].id,
    oldValue: existing[0] ?? undefined,
    newValue: rows[0],
  });

  return rows[0];
}

export async function getAttendanceRecord(id: number) {
  const { rows } = await query(
    `select ar.*, e.employee_name, em.employee_code, ast.status_code, ast.status_name
     from attendance_records ar
     join employees e on e.id = ar.employee_id
     join employee_master em on em.employee_id = ar.employee_id
     join attendance_statuses ast on ast.id = ar.status_id
     where ar.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new AttendanceRecordNotFoundError(id);
  return rows[0];
}

export type AttendanceListFilters = {
  employeeId?: number;
  departmentId?: number;
  dateFrom?: string;
  dateTo?: string;
  statusCode?: string;
  page?: number;
  pageSize?: number;
};

export async function listAttendanceRecords(filters: AttendanceListFilters) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.employeeId) { params.push(filters.employeeId); conditions.push(`ar.employee_id = $${params.length}`); }
  if (filters.departmentId) { params.push(filters.departmentId); conditions.push(`em.department_id = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); conditions.push(`ar.attendance_date >= $${params.length}`); }
  if (filters.dateTo) { params.push(filters.dateTo); conditions.push(`ar.attendance_date <= $${params.length}`); }
  if (filters.statusCode) { params.push(filters.statusCode); conditions.push(`ast.status_code = $${params.length}`); }

  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const pageSize = Math.min(filters.pageSize ?? 50, 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  params.push(pageSize, offset);
  const { rows } = await query(
    `select ar.*, e.employee_name, em.employee_code, ast.status_code, ast.status_name
     from attendance_records ar
     join employees e on e.id = ar.employee_id
     join employee_master em on em.employee_id = ar.employee_id
     join attendance_statuses ast on ast.id = ar.status_id
     ${where}
     order by ar.attendance_date desc, em.employee_code
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );

  const { rows: countRows } = await query(
    `select count(*) from attendance_records ar
     join employee_master em on em.employee_id = ar.employee_id
     join attendance_statuses ast on ast.id = ar.status_id
     ${where}`,
    params.slice(0, params.length - 2),
  );

  return { rows, total: Number(countRows[0].count), page, pageSize };
}
