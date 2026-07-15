import { pool, query } from "../db/pool.ts";

/** Every function here derives from leave_requests / leave_balance_transactions at query time — no stored summary, same discipline as attendance-reports.ts. */

export async function leaveRegister(filters: { dateFrom?: string; dateTo?: string; departmentId?: number; status?: string }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.dateFrom) { params.push(filters.dateFrom); conditions.push(`lr.to_date >= $${params.length}`); }
  if (filters.dateTo) { params.push(filters.dateTo); conditions.push(`lr.from_date <= $${params.length}`); }
  if (filters.departmentId) { params.push(filters.departmentId); conditions.push(`em.department_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); conditions.push(`lr.status = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

  const { rows } = await query(
    `select lr.*, em.employee_code, e.employee_name, lt.leave_type_name, em.department_id
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

export async function leaveBalanceReport(leaveYear: number, filters: { departmentId?: number } = {}) {
  const conditions = [`lbt.leave_year = $1`];
  const params: unknown[] = [leaveYear];
  if (filters.departmentId) { params.push(filters.departmentId); conditions.push(`em.department_id = $${params.length}`); }

  const { rows } = await query(
    `select em.employee_code, e.employee_name, lt.leave_type_code, lt.leave_type_name, sum(lbt.days) as balance
     from leave_balance_transactions lbt
     join employees e on e.id = lbt.employee_id
     join employee_master em on em.employee_id = lbt.employee_id
     join leave_types lt on lt.id = lbt.leave_type_id
     where ${conditions.join(" and ")}
     group by em.employee_code, e.employee_name, lt.leave_type_code, lt.leave_type_name
     order by em.employee_code, lt.leave_type_code`,
    params,
  );
  return rows;
}

export async function leaveUtilizationReport(leaveYear: number, filters: { departmentId?: number } = {}) {
  const conditions = [`lbt.leave_year = $1`];
  const params: unknown[] = [leaveYear];
  if (filters.departmentId) { params.push(filters.departmentId); conditions.push(`em.department_id = $${params.length}`); }

  const { rows } = await query(
    `select em.employee_code, e.employee_name, lt.leave_type_code, lt.leave_type_name,
            coalesce(sum(lbt.days) filter (where lbt.days > 0), 0) as total_credited,
            coalesce(-sum(lbt.days) filter (where lbt.transaction_type = 'consumption'), 0) as total_consumed,
            coalesce(sum(lbt.days), 0) as closing_balance
     from leave_balance_transactions lbt
     join employees e on e.id = lbt.employee_id
     join employee_master em on em.employee_id = lbt.employee_id
     join leave_types lt on lt.id = lbt.leave_type_id
     where ${conditions.join(" and ")}
     group by em.employee_code, e.employee_name, lt.leave_type_code, lt.leave_type_name
     order by em.employee_code, lt.leave_type_code`,
    params,
  );
  return rows;
}

/** Team calendar view: approved leave overlapping a date range. */
export async function leaveCalendar(dateFrom: string, dateTo: string, filters: { departmentId?: number } = {}) {
  const conditions = [`lr.status = 'approved'`, `lr.from_date <= $2`, `lr.to_date >= $1`];
  const params: unknown[] = [dateFrom, dateTo];
  if (filters.departmentId) { params.push(filters.departmentId); conditions.push(`em.department_id = $${params.length}`); }

  const { rows } = await query(
    `select lr.id, lr.employee_id, em.employee_code, e.employee_name, lr.from_date, lr.to_date, lr.is_half_day, lt.leave_type_name
     from leave_requests lr
     join employees e on e.id = lr.employee_id
     join employee_master em on em.employee_id = lr.employee_id
     join leave_types lt on lt.id = lr.leave_type_id
     where ${conditions.join(" and ")}
     order by lr.from_date`,
    params,
  );
  return rows;
}

export async function employeeLeaveHistory(employeeId: number) {
  const { rows: requests } = await query(
    `select lr.*, lt.leave_type_name from leave_requests lr join leave_types lt on lt.id = lr.leave_type_id where lr.employee_id = $1 order by lr.from_date desc`,
    [employeeId],
  );
  const { rows: ledger } = await query(
    `select lbt.*, lt.leave_type_name from leave_balance_transactions lbt join leave_types lt on lt.id = lbt.leave_type_id where lbt.employee_id = $1 order by lbt.created_at desc`,
    [employeeId],
  );
  return { requests, ledger };
}

export async function departmentLeaveSummary(dateFrom: string, dateTo: string) {
  const { rows } = await query(
    `select em.department_id, d.department_name, lt.leave_type_name, count(*) as request_count, sum(lr.day_count) as total_days
     from leave_requests lr
     join employee_master em on em.employee_id = lr.employee_id
     left join departments d on d.id = em.department_id
     join leave_types lt on lt.id = lr.leave_type_id
     where lr.status = 'approved' and lr.from_date <= $2 and lr.to_date >= $1
     group by em.department_id, d.department_name, lt.leave_type_name
     order by d.department_name, lt.leave_type_name`,
    [dateFrom, dateTo],
  );
  return rows;
}
