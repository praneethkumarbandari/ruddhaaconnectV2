import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { PgClient } from "../db/pool.ts";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "../lib/audit.ts";

// ------------------------------------------------------------
// Domain errors. Registered in error-mapping.ts (this resource is
// complex enough to follow the sales.ts/purchases.ts centralized
// error-mapping convention, not the inline-per-route pattern used by
// Milestone 1's simple lookup masters — see HR_MODULE_MILESTONE_2.md
// for why the split exists.)
// ------------------------------------------------------------
export class EmployeeNotFoundError extends Error {
  constructor(employeeId: number) {
    super(`Employee ${employeeId} not found.`);
    this.name = "EmployeeNotFoundError";
  }
}

export class SelfManagerError extends Error {
  constructor() {
    super("An employee cannot be their own reporting manager.");
    this.name = "SelfManagerError";
  }
}

export class CircularReportingError extends Error {
  constructor(employeeId: number, managerId: number) {
    super(`Setting employee ${managerId} as the manager of employee ${employeeId} would create a circular reporting relationship.`);
    this.name = "CircularReportingError";
  }
}

export class ReportingManagerNotFoundError extends Error {
  constructor(managerId: number) {
    super(`Proposed reporting manager (employee ${managerId}) does not exist.`);
    this.name = "ReportingManagerNotFoundError";
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition employee status from '${from}' to '${to}'.`);
    this.name = "InvalidStatusTransitionError";
  }
}

export class ExitDateRequiredError extends Error {
  constructor() {
    super("exitDate is required when status is set to 'exited'.");
    this.name = "ExitDateRequiredError";
  }
}

export class InvalidMasterReferenceError extends Error {
  constructor(field: string) {
    super(`${field} does not reference an existing record.`);
    this.name = "InvalidMasterReferenceError";
  }
}

// ------------------------------------------------------------
// Status transitions. 'exited' is terminal — rehiring a former
// employee is a new employee record in this milestone's scope, not a
// status flip back to 'active' on the same row (their history,
// documents, and asset returns stay attached to the record that
// actually reflects when they left).
// ------------------------------------------------------------
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  active: ["on_notice", "suspended", "exited"],
  on_notice: ["active", "exited"],
  suspended: ["active", "exited"],
  exited: [],
};

export function assertValidStatusTransition(from: string, to: string) {
  if (from === to) return; // no-op update, always allowed
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}

/**
 * True if setting `proposedManagerId` as the manager of `employeeId`
 * would create a cycle. Walks the manager chain UPWARD from
 * proposedManagerId (including proposedManagerId itself, so a direct
 * self-manager attempt is also caught here, though callers should
 * reject that case earlier with the clearer SelfManagerError first).
 */
export async function wouldCreateCycle(client: PgClient, employeeId: number, proposedManagerId: number): Promise<boolean> {
  const { rows } = await client.query(
    `with recursive ancestors as (
       select $1::bigint as emp_id, 0 as depth
       union all
       select em.reporting_manager_id, a.depth + 1
       from employee_master em
       join ancestors a on em.employee_id = a.emp_id
       where em.reporting_manager_id is not null and a.depth < 100
     )
     select 1 from ancestors where emp_id = $2 limit 1`,
    [proposedManagerId, employeeId],
  );
  return rows.length > 0;
}

async function validateReportingManager(client: PgClient, employeeId: number, reportingManagerId: number | null) {
  if (reportingManagerId == null) return;
  // FIX: same bug class as departments' self-parent check — employee
  // ids are Postgres bigints, returned as strings by the `pg` driver,
  // so a client round-tripping an id through JSON can send it back as
  // a string. `employeeId` here is a Number()-coerced route param, so
  // a bare `===` silently never caught a self-manager assignment made
  // with a string id. Coerce both sides before comparing.
  const normalizedManagerId = Number(reportingManagerId);
  if (normalizedManagerId === employeeId) throw new SelfManagerError();

  // Architecture Review Gate finding: checking `employees` alone only
  // proves the proposed manager is SOME authenticated identity — it
  // would accept a login-only account with no HR profile at all.
  // A manager must be a real HR employee, so this checks
  // employee_master, not employees.
  const { rows } = await client.query(`select 1 from employee_master where employee_id = $1`, [normalizedManagerId]);
  if (rows.length === 0) throw new ReportingManagerNotFoundError(normalizedManagerId);

  if (await wouldCreateCycle(client, employeeId, normalizedManagerId)) {
    throw new CircularReportingError(employeeId, normalizedManagerId);
  }
}

/** Checks a nullable FK field exists in the given table before insert/update, with a field-name-specific error rather than a generic 23503. */
async function validateReference(client: PgClient, table: string, id: number | null | undefined, fieldName: string) {
  if (id == null) return;
  const { rows } = await client.query(`select 1 from ${table} where id = $1`, [id]);
  if (rows.length === 0) throw new InvalidMasterReferenceError(fieldName);
}

export type CreateEmployeeInput = {
  employeeCode: string;
  employeeName: string;
  email?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  departmentId?: number | null;
  designationId?: number | null;
  branchId?: number | null;
  costCenterId?: number | null;
  employmentTypeId?: number | null;
  shiftId?: number | null;
  reportingManagerId?: number | null;
  joiningDate: string;
  confirmationDate?: string | null;
  remarks?: string | null;
};

/**
 * Creates BOTH the identity row (employees) and the profile row
 * (employee_master) in one transaction. This is the one place in the
 * codebase that inserts into `employees` outside of the original
 * schema.sql seed — a deliberate, disclosed choice: HR is where new
 * hires are provisioned, and employee_master cannot exist without an
 * employees row to extend (see the FK). A random temporary password
 * is generated and its bcrypt hash stored, exactly like auth.ts
 * expects; there is no invite/reset-password flow in this codebase
 * yet to hand that credential to the new hire — see
 * HR_MODULE_MILESTONE_2.md for that disclosed, out-of-scope gap. The
 * plaintext temporary password is returned ONCE in the create
 * response (never stored, never logged) so the caller has something
 * to hand off manually until a real flow exists.
 */
export async function createEmployee(actorUserId: number | null, input: CreateEmployeeInput) {
  return withTransaction(async (client) => {
    await validateReference(client, "departments", input.departmentId, "departmentId");
    await validateReference(client, "designations", input.designationId, "designationId");
    await validateReference(client, "branches", input.branchId, "branchId");
    await validateReference(client, "cost_centers", input.costCenterId, "costCenterId");
    await validateReference(client, "employment_types", input.employmentTypeId, "employmentTypeId");
    await validateReference(client, "shifts", input.shiftId, "shiftId");
    if (input.reportingManagerId != null) {
      const { rows } = await client.query(`select 1 from employee_master where employee_id = $1`, [input.reportingManagerId]);
      if (rows.length === 0) throw new ReportingManagerNotFoundError(input.reportingManagerId);
      // No cycle check needed on create: a brand-new employee has no
      // existing row for anyone to already report to, so no chain
      // through them can exist yet.
    }

    const temporaryPassword = crypto.randomBytes(9).toString("base64url"); // 12 chars, URL-safe
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    const username = input.employeeCode.toLowerCase();

    const { rows: employeeRows } = await client.query(
      `insert into employees (username, email, employee_name, password_hash)
       values ($1, $2, $3, $4)
       returning id`,
      [username, input.email ?? null, input.employeeName, passwordHash],
    );
    const employeeId = employeeRows[0].id;

    // FIX: nothing here ever granted a role. Every self-service
    // permission in the system (view own attendance, request a
    // correction, apply for leave, etc.) is gated behind the EMPLOYEE
    // role — schema-attendance.sql's own seed comments describe it as
    // "the baseline role every employee has" — but createEmployee
    // never actually assigned it. A brand-new hire created through
    // this endpoint could log in but had zero permissions and could
    // do nothing until an admin separately called
    // POST /roles/employees/:employeeId, a manual step nothing in
    // this flow surfaces as required. Assign the baseline role here,
    // in the same transaction, so a new employee is immediately
    // functional the way the rest of the system already assumes.
    const { rows: baselineRole } = await client.query(`select id from roles where role_code = 'EMPLOYEE'`);
    if (baselineRole.length > 0) {
      await client.query(
        `insert into user_roles (employee_id, role_id, assigned_by) values ($1, $2, $3) on conflict do nothing`,
        [employeeId, baselineRole[0].id, actorUserId],
      );
    }

    const { rows: masterRows } = await client.query(
      `insert into employee_master (
         employee_id, employee_code, date_of_birth, gender,
         department_id, designation_id, branch_id, cost_center_id,
         employment_type_id, shift_id, reporting_manager_id,
         joining_date, confirmation_date, remarks
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning *`,
      [
        employeeId, input.employeeCode, input.dateOfBirth ?? null, input.gender ?? null,
        input.departmentId ?? null, input.designationId ?? null, input.branchId ?? null, input.costCenterId ?? null,
        input.employmentTypeId ?? null, input.shiftId ?? null, input.reportingManagerId ?? null,
        input.joiningDate, input.confirmationDate ?? null, input.remarks ?? null,
      ],
    );
    const master = masterRows[0];

    await writeAudit(client, {
      userId: actorUserId,
      action: "create",
      module: "employee_master",
      recordId: employeeId,
      newValue: { ...master, username, email: input.email ?? null },
    });

    return { ...master, username, employeeName: input.employeeName, email: input.email ?? null, temporaryPassword };
  });
}

export type UpdateEmployeeInput = Partial<{
  dateOfBirth: string | null;
  gender: string | null;
  departmentId: number | null;
  designationId: number | null;
  branchId: number | null;
  costCenterId: number | null;
  employmentTypeId: number | null;
  shiftId: number | null;
  reportingManagerId: number | null;
  status: string;
  confirmationDate: string | null;
  exitDate: string | null;
  remarks: string | null;
}>;

export async function updateEmployee(actorUserId: number | null, employeeId: number, input: UpdateEmployeeInput) {
  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(`select * from employee_master where employee_id = $1`, [employeeId]);
    if (existingRows.length === 0) throw new EmployeeNotFoundError(employeeId);
    const existing = existingRows[0];

    await validateReference(client, "departments", input.departmentId, "departmentId");
    await validateReference(client, "designations", input.designationId, "designationId");
    await validateReference(client, "branches", input.branchId, "branchId");
    await validateReference(client, "cost_centers", input.costCenterId, "costCenterId");
    await validateReference(client, "employment_types", input.employmentTypeId, "employmentTypeId");
    await validateReference(client, "shifts", input.shiftId, "shiftId");

    // Coerce both sides before comparing — existing.reporting_manager_id
    // comes back from Postgres as a bigint-string; input.reportingManagerId
    // is whatever type the client sent in JSON. A bare !== here would
    // treat "5" and 5 as a real change even when nothing changed, and
    // (more importantly) can mask a genuine change if both happen to be
    // strings — normalize to numbers so the comparison means what it says.
    const existingManagerId = existing.reporting_manager_id != null ? Number(existing.reporting_manager_id) : null;
    const nextManagerId = input.reportingManagerId != null ? Number(input.reportingManagerId) : (
      "reportingManagerId" in input ? input.reportingManagerId : undefined
    );
    const managerChanged = "reportingManagerId" in input && nextManagerId !== existingManagerId;
    if (managerChanged && input.reportingManagerId != null) {
      await validateReportingManager(client, employeeId, input.reportingManagerId);
    }

    const nextStatus = input.status ?? existing.status;
    if (input.status) {
      assertValidStatusTransition(existing.status, input.status);
    }
    const nextExitDate = "exitDate" in input ? input.exitDate : existing.exit_date;
    if (nextStatus === "exited" && !nextExitDate) {
      throw new ExitDateRequiredError();
    }

    const { rows } = await client.query(
      `update employee_master set
         date_of_birth = coalesce($2, date_of_birth),
         gender = coalesce($3, gender),
         department_id = $4,
         designation_id = $5,
         branch_id = $6,
         cost_center_id = $7,
         employment_type_id = $8,
         shift_id = $9,
         reporting_manager_id = $10,
         status = $11,
         confirmation_date = $12,
         exit_date = $13,
         remarks = coalesce($14, remarks),
         updated_at = now()
       where employee_id = $1
       returning *`,
      [
        employeeId,
        input.dateOfBirth ?? null,
        input.gender ?? null,
        "departmentId" in input ? input.departmentId : existing.department_id,
        "designationId" in input ? input.designationId : existing.designation_id,
        "branchId" in input ? input.branchId : existing.branch_id,
        "costCenterId" in input ? input.costCenterId : existing.cost_center_id,
        "employmentTypeId" in input ? input.employmentTypeId : existing.employment_type_id,
        "shiftId" in input ? input.shiftId : existing.shift_id,
        "reportingManagerId" in input ? input.reportingManagerId : existing.reporting_manager_id,
        nextStatus,
        "confirmationDate" in input ? input.confirmationDate : existing.confirmation_date,
        nextExitDate,
        input.remarks ?? null,
      ],
    );
    const updated = rows[0];

    // Deactivating/reactivating login access is a direct, intended
    // side effect of the status transition, not a separate step the
    // caller must remember — an 'exited' or 'suspended' employee who
    // can still obtain a fresh JWT is a real security gap, and this
    // is the ONE place in the codebase that flips employees.is_active
    // after initial creation. auth.ts's login query already checks
    // is_active = true, so this alone is sufficient to block login;
    // nothing in auth.ts needed to change.
    if (input.status && input.status !== existing.status) {
      const shouldBeActive = input.status === "active" || input.status === "on_notice";
      await client.query(`update employees set is_active = $2 where id = $1`, [employeeId, shouldBeActive]);
    }

    const action = input.status && input.status !== existing.status
      ? (input.status === "exited" ? "deactivate" : "update")
      : "update";

    await writeAudit(client, {
      userId: actorUserId,
      action,
      module: "employee_master",
      recordId: employeeId,
      oldValue: existing,
      newValue: updated,
    });

    return updated;
  });
}

export async function getEmployee(employeeId: number) {
  const { rows } = await query(
    `select em.*, e.username, e.email, e.employee_name, e.is_active as login_active
     from employee_master em
     join employees e on e.id = em.employee_id
     where em.employee_id = $1`,
    [employeeId],
  );
  if (rows.length === 0) throw new EmployeeNotFoundError(employeeId);
  return rows[0];
}

export type EmployeeListFilters = {
  search?: string;
  departmentId?: number;
  designationId?: number;
  branchId?: number;
  status?: string;
  page?: number;
  pageSize?: number;
};

/**
 * Serves both "Employee List" and "Employee Search" from the spec as
 * one endpoint — search is a filter on the same list, not a separate
 * route, since the result shape and pagination needs are identical.
 * Documented here rather than left implicit.
 */
export async function listEmployees(filters: EmployeeListFilters) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.search) {
    params.push(`%${filters.search.toLowerCase()}%`);
    conditions.push(`(lower(e.employee_name) like $${params.length} or lower(em.employee_code) like $${params.length} or lower(e.email) like $${params.length})`);
  }
  if (filters.departmentId) {
    params.push(filters.departmentId);
    conditions.push(`em.department_id = $${params.length}`);
  }
  if (filters.designationId) {
    params.push(filters.designationId);
    conditions.push(`em.designation_id = $${params.length}`);
  }
  if (filters.branchId) {
    params.push(filters.branchId);
    conditions.push(`em.branch_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`em.status = $${params.length}`);
  }

  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const pageSize = Math.min(filters.pageSize ?? 50, 200);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  params.push(pageSize, offset);
  const { rows } = await query(
    `select em.*, e.username, e.email, e.employee_name
     from employee_master em
     join employees e on e.id = em.employee_id
     ${where}
     order by em.employee_code
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );

  const { rows: countRows } = await query(
    `select count(*) from employee_master em join employees e on e.id = em.employee_id ${where}`,
    params.slice(0, params.length - 2),
  );

  return { rows, total: Number(countRows[0].count), page, pageSize };
}

/**
 * Downward org tree from `employeeId`: direct reports, their direct
 * reports, etc. Derived on every call, never stored — same "reports
 * are always derived" discipline as the accounting module's reports.ts,
 * applied to org structure instead of financial data.
 */
export async function getOrgTree(rootEmployeeId: number) {
  const { rows } = await query(
    `with recursive tree as (
       select em.employee_id, em.reporting_manager_id, e.employee_name, em.employee_code, em.designation_id, 0 as depth
       from employee_master em
       join employees e on e.id = em.employee_id
       where em.employee_id = $1
       union all
       select em.employee_id, em.reporting_manager_id, e.employee_name, em.employee_code, em.designation_id, t.depth + 1
       from employee_master em
       join employees e on e.id = em.employee_id
       join tree t on em.reporting_manager_id = t.employee_id
       -- Depth cap is a safety circuit breaker, not a business rule:
       -- wouldCreateCycle() already prevents cycles at write time, so
       -- this recursion should always terminate on its own. The cap
       -- only matters if that invariant is ever violated some other
       -- way (a direct SQL edit, a future migration bug) — without
       -- it, a corrupted cycle here would spin forever and tie up a
       -- connection from the pool rather than erroring visibly.
       -- 100 levels is far beyond any real org chart. Added during
       -- the Architecture Review Gate.
       where t.depth < 100
     )
     select * from tree order by depth, employee_code`,
    [rootEmployeeId],
  );
  if (rows.length === 0) throw new EmployeeNotFoundError(rootEmployeeId);
  return rows;
}

/** Upward chain: this employee's manager, their manager, etc. — used to render a breadcrumb, not for cycle detection (see wouldCreateCycle for that). Same depth cap and rationale as getOrgTree. */
export async function getManagerChain(employeeId: number) {
  const { rows } = await query(
    `with recursive chain as (
       select em.employee_id, em.reporting_manager_id, e.employee_name, em.employee_code, 0 as depth
       from employee_master em
       join employees e on e.id = em.employee_id
       where em.employee_id = $1
       union all
       select em.employee_id, em.reporting_manager_id, e.employee_name, em.employee_code, c.depth + 1
       from employee_master em
       join employees e on e.id = em.employee_id
       join chain c on em.employee_id = c.reporting_manager_id
       where c.depth < 100
     )
     select * from chain where depth > 0 order by depth`,
    [employeeId],
  );
  return rows;
}
