import { pool, query } from "../db/pool.ts";

/**
 * Every function here is a plain SELECT/aggregate against
 * attendance_records — no summary table, no cached total, matching
 * the "reports are always derived, never stored" discipline this
 * codebase already established for the accounting module's reports.ts.
 */

export async function dailyAttendanceReport(date: string, filters: { departmentId?: number; branchId?: number } = {}) {
  const conditions = [`ar.attendance_date = $1`];
  const params: unknown[] = [date];
  if (filters.departmentId) { params.push(filters.departmentId); conditions.push(`em.department_id = $${params.length}`); }
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`em.branch_id = $${params.length}`); }

  const { rows } = await query(
    `select ar.*, e.employee_name, em.employee_code, ast.status_code, ast.status_name
     from attendance_records ar
     join employees e on e.id = ar.employee_id
     join employee_master em on em.employee_id = ar.employee_id
     join attendance_statuses ast on ast.id = ar.status_id
     where ${conditions.join(" and ")}
     order by em.employee_code`,
    params,
  );
  return rows;
}

export async function monthlyAttendanceRegister(year: number, month: number, filters: { departmentId?: number } = {}) {
  const conditions = [`extract(year from ar.attendance_date) = $1`, `extract(month from ar.attendance_date) = $2`];
  const params: unknown[] = [year, month];
  if (filters.departmentId) { params.push(filters.departmentId); conditions.push(`em.department_id = $${params.length}`); }

  const { rows } = await query(
    `select em.employee_code, e.employee_name,
            count(*) filter (where ast.status_code = 'PRESENT') as present_days,
            count(*) filter (where ast.status_code = 'HALF_DAY') as half_days,
            count(*) filter (where ast.status_code = 'ABSENT') as absent_days,
            count(*) filter (where ast.status_code = 'HOLIDAY') as holiday_days,
            count(*) filter (where ast.status_code = 'WEEKLY_OFF') as weekly_off_days,
            coalesce(sum(ar.late_minutes), 0) as total_late_minutes,
            coalesce(sum(ar.overtime_minutes), 0) as total_overtime_minutes
     from attendance_records ar
     join employees e on e.id = ar.employee_id
     join employee_master em on em.employee_id = ar.employee_id
     join attendance_statuses ast on ast.id = ar.status_id
     where ${conditions.join(" and ")}
     group by em.employee_code, e.employee_name
     order by em.employee_code`,
    params,
  );
  return rows;
}

async function thresholdReport(kind: "late" | "early", dateFrom: string, dateTo: string) {
  const column = kind === "late" ? "late_minutes" : "early_exit_minutes";
  const { rows } = await query(
    `select ar.attendance_date, em.employee_code, e.employee_name, ar.${column} as minutes, ar.in_timestamp, ar.out_timestamp
     from attendance_records ar
     join employees e on e.id = ar.employee_id
     join employee_master em on em.employee_id = ar.employee_id
     where ar.attendance_date between $1 and $2 and ar.${column} > 0
     order by ar.attendance_date, em.employee_code`,
    [dateFrom, dateTo],
  );
  return rows;
}

export const lateEntryReport = (dateFrom: string, dateTo: string) => thresholdReport("late", dateFrom, dateTo);
export const earlyExitReport = (dateFrom: string, dateTo: string) => thresholdReport("early", dateFrom, dateTo);

export async function overtimeReport(dateFrom: string, dateTo: string) {
  const { rows } = await query(
    `select ar.attendance_date, em.employee_code, e.employee_name, ar.overtime_minutes
     from attendance_records ar
     join employees e on e.id = ar.employee_id
     join employee_master em on em.employee_id = ar.employee_id
     where ar.attendance_date between $1 and $2 and ar.overtime_minutes > 0
     order by ar.attendance_date, em.employee_code`,
    [dateFrom, dateTo],
  );
  return rows;
}

export async function absentReport(dateFrom: string, dateTo: string) {
  const { rows } = await query(
    `select ar.attendance_date, em.employee_code, e.employee_name
     from attendance_records ar
     join employees e on e.id = ar.employee_id
     join employee_master em on em.employee_id = ar.employee_id
     join attendance_statuses ast on ast.id = ar.status_id
     where ar.attendance_date between $1 and $2 and ast.status_code = 'ABSENT'
     order by ar.attendance_date, em.employee_code`,
    [dateFrom, dateTo],
  );
  return rows;
}

export async function attendanceSummary(employeeId: number, dateFrom: string, dateTo: string) {
  const { rows } = await query(
    `select
       count(*) filter (where ast.status_code = 'PRESENT') as present_days,
       count(*) filter (where ast.status_code = 'HALF_DAY') as half_days,
       count(*) filter (where ast.status_code = 'ABSENT') as absent_days,
       count(*) filter (where ast.status_code = 'HOLIDAY') as holiday_days,
       count(*) filter (where ast.status_code = 'WEEKLY_OFF') as weekly_off_days,
       coalesce(sum(ar.working_minutes), 0) as total_working_minutes,
       coalesce(sum(ar.late_minutes), 0) as total_late_minutes,
       coalesce(sum(ar.early_exit_minutes), 0) as total_early_exit_minutes,
       coalesce(sum(ar.overtime_minutes), 0) as total_overtime_minutes
     from attendance_records ar
     join attendance_statuses ast on ast.id = ar.status_id
     where ar.employee_id = $1 and ar.attendance_date between $2 and $3`,
    [employeeId, dateFrom, dateTo],
  );
  return rows[0];
}
