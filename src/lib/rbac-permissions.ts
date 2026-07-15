import { pool, query } from "../db/pool.ts";

/**
 * Generic RBAC resolution. Deliberately has no HR-specific
 * knowledge — a permission_code is just a string ('hr.department.manage',
 * 'accounting.journal_entry.post', ...) and this file doesn't care
 * which module defined it. Any module can call employeeHasPermission()
 * or mount requirePermission() from lib/permission-middleware.ts.
 *
 * SYSTEM_ADMIN is a hard-coded bypass rather than a row-per-permission
 * grant, so a new module's freshly-seeded permission codes are usable
 * by SYSTEM_ADMIN immediately without a follow-up migration re-granting
 * them. This is the ONE piece of role-name-specific logic in this file,
 * on purpose — everything else resolves through data, not code.
 */
const SUPER_ROLE_CODE = "SYSTEM_ADMIN";

export async function employeeHasRole(employeeId: number, roleCode: string): Promise<boolean> {
  const { rows } = await query(
    `select 1
     from user_roles ur
     join roles r on r.id = ur.role_id
     where ur.employee_id = $1 and r.role_code = $2 and r.is_active = true
     limit 1`,
    [employeeId, roleCode],
  );
  return rows.length > 0;
}

/**
 * True if the employee holds permissionCode, either directly through
 * a role they're assigned, or through that role's parent_role_id
 * chain (single-parent inheritance, walked recursively). SYSTEM_ADMIN
 * always returns true regardless of role_permissions rows.
 */
export async function employeeHasPermission(employeeId: number, permissionCode: string): Promise<boolean> {
  if (await employeeHasRole(employeeId, SUPER_ROLE_CODE)) return true;

  // Walks the same parent_role_id chain as getEmployeeEffectivePermissions
  // (single recursive CTE, not two divergent copies of the inheritance
  // rule) but stops at the first match instead of collecting every code —
  // cheaper for the common "am I allowed to do this one thing" check that
  // runs on every permission-gated request.
  const { rows } = await query(
    `with recursive role_chain as (
       select r.id, r.parent_role_id from roles r
       join user_roles ur on ur.role_id = r.id
       where ur.employee_id = $1 and r.is_active = true
       union
       select parent.id, parent.parent_role_id from roles parent
       join role_chain rc on parent.id = rc.parent_role_id
     )
     select 1
     from role_chain rc
     join role_permissions rp on rp.role_id = rc.id
     join permissions p on p.id = rp.permission_id
     where p.permission_code = $2
     limit 1`,
    [employeeId, permissionCode],
  );
  return rows.length > 0;
}

/** All permission codes the employee currently holds (direct + inherited), expanded for SYSTEM_ADMIN as "*". */
export async function getEmployeeEffectivePermissions(employeeId: number): Promise<string[]> {
  if (await employeeHasRole(employeeId, SUPER_ROLE_CODE)) return ["*"];

  const { rows } = await query(
    `with recursive role_chain as (
       select r.id, r.parent_role_id from roles r
       join user_roles ur on ur.role_id = r.id
       where ur.employee_id = $1 and r.is_active = true
       union
       select parent.id, parent.parent_role_id from roles parent
       join role_chain rc on parent.id = rc.parent_role_id
     )
     select distinct p.permission_code
     from role_chain rc
     join role_permissions rp on rp.role_id = rc.id
     join permissions p on p.id = rp.permission_id
     order by p.permission_code`,
    [employeeId],
  );
  return rows.map((r) => r.permission_code);
}

export async function getEmployeeRoles(employeeId: number): Promise<{ id: number; roleCode: string; roleName: string }[]> {
  const { rows } = await query(
    `select r.id, r.role_code, r.role_name
     from user_roles ur
     join roles r on r.id = ur.role_id
     where ur.employee_id = $1
     order by r.role_code`,
    [employeeId],
  );
  return rows.map((r) => ({ id: r.id, roleCode: r.role_code, roleName: r.role_name }));
}

export class RoleNotFoundError extends Error {
  constructor(id: number) {
    super(`Role ${id} not found.`);
    this.name = "RoleNotFoundError";
  }
}

export class PermissionNotFoundError extends Error {
  constructor(id: number) {
    super(`Permission ${id} not found.`);
    this.name = "PermissionNotFoundError";
  }
}

export class SystemRoleImmutableError extends Error {
  constructor(roleCode: string) {
    super(`Role '${roleCode}' is a system role and cannot be deleted or have its role_code changed.`);
    this.name = "SystemRoleImmutableError";
  }
}
