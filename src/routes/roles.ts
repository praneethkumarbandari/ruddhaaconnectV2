import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "../lib/audit.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import {
  getEmployeeEffectivePermissions,
  getEmployeeRoles,
  RoleNotFoundError,
  SystemRoleImmutableError,
} from "../lib/rbac-permissions.ts";

/**
 * ERP-wide RBAC administration. Lives outside routes/hr/* on purpose —
 * this is infrastructure every module shares, not an HR endpoint, and
 * is gated by admin.rbac.* rather than any hr.* permission (see the
 * seed comment in schema-permissions.sql for why HR_ADMIN does not
 * get this by default).
 */
const router = Router();

// ------------------------------------------------------------
// Self-service: "what can I do" — no admin.rbac.view required,
// since every authenticated employee needs this to know which UI
// to render. Deliberately read-only and scoped to req.user only;
// this is not a way to inspect anyone else's permissions.
// ------------------------------------------------------------
router.get("/me", asyncHandler(async (req: Request, res: Response) => {
  const employeeId = req.user!.userId;
  const [roles, permissions] = await Promise.all([
    getEmployeeRoles(employeeId),
    getEmployeeEffectivePermissions(employeeId),
  ]);
  return res.status(200).json({ roles, permissions });
}));

router.get("/", requirePermission("admin.rbac.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from roles order by role_code`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("admin.rbac.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { roleCode, roleName, description, parentRoleId } = req.body ?? {};
  if (!roleCode || !roleName) {
    return res.status(400).json({ error: "roleCode and roleName are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into roles (role_code, role_name, description, parent_role_id)
         values ($1, $2, $3, $4) returning *`,
        [roleCode, roleName, description ?? null, parentRoleId ?? null],
      );
      const role = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "roles",
        recordId: role.id,
        newValue: role,
      });
      return role;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Role code "${roleCode}" already exists.` });
    }
    throw err;
  }
}));

router.patch("/:id", requirePermission("admin.rbac.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { roleName, description, parentRoleId } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from roles where id = $1`, [id]);
    if (existing.length === 0) throw new RoleNotFoundError(id);
    // role_code is immutable for every role once created (system or
    // custom) — it's the stable identifier other code/seeds reference,
    // same reasoning as account_code never being editable in
    // chart-of-accounts. Only display fields and inheritance are editable.
    const { rows } = await client.query(
      `update roles set
         role_name = coalesce($2, role_name),
         description = coalesce($3, description),
         parent_role_id = $4,
         updated_at = now()
       where id = $1
       returning *`,
      [id, roleName ?? null, description ?? null, parentRoleId ?? existing[0].parent_role_id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "roles",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  return res.status(200).json(result);
}));

router.delete("/:id", requirePermission("admin.rbac.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`select * from roles where id = $1`, [id]);
      if (existing.length === 0) throw new RoleNotFoundError(id);
      if (existing[0].is_system) throw new SystemRoleImmutableError(existing[0].role_code);

      await client.query(`delete from roles where id = $1`, [id]);
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "update",
        module: "roles",
        recordId: id,
        oldValue: existing[0],
      });
      return existing[0];
    });
    return res.status(200).json({ deleted: result });
  } catch (err) {
    if (err instanceof RoleNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof SystemRoleImmutableError) return res.status(409).json({ error: err.message });
    if ((err as { code?: string }).code === "23503") {
      return res.status(409).json({ error: "Role is still assigned to one or more employees; revoke it first." });
    }
    throw err;
  }
}));

router.get("/:id/permissions", requirePermission("admin.rbac.view"), asyncHandler(async (req: Request, res: Response) => {
  const roleId = Number(req.params.id);
  try {
    const { rows: role } = await query(`select id from roles where id = $1`, [roleId]);
    if (role.length === 0) throw new RoleNotFoundError(roleId);

    const { rows } = await query(
      `select permission_id from role_permissions where role_id = $1`,
      [roleId],
    );
    return res.status(200).json({ roleId, permissionIds: rows.map((r) => Number(r.permission_id)) });
  } catch (err) {
    if (err instanceof RoleNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

router.post("/:id/permissions", requirePermission("admin.rbac.manage"), asyncHandler(async (req: Request, res: Response) => {
  const roleId = Number(req.params.id);
  const { permissionId } = req.body ?? {};
  if (!permissionId) return res.status(400).json({ error: "permissionId is required." });

  const result = await withTransaction(async (client) => {
    const { rows: role } = await client.query(`select * from roles where id = $1`, [roleId]);
    if (role.length === 0) throw new RoleNotFoundError(roleId);

    const { rows } = await client.query(
      `insert into role_permissions (role_id, permission_id) values ($1, $2)
       on conflict do nothing returning *`,
      [roleId, permissionId],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "role_permissions",
      recordId: roleId,
      newValue: { roleId, permissionId, granted: rows.length > 0 },
    });
    return { roleId, permissionId };
  });

  return res.status(201).json(result);
}));

router.delete("/:id/permissions/:permissionId", requirePermission("admin.rbac.manage"), asyncHandler(async (req: Request, res: Response) => {
  const roleId = Number(req.params.id);
  const permissionId = Number(req.params.permissionId);

  await withTransaction(async (client) => {
    await client.query(`delete from role_permissions where role_id = $1 and permission_id = $2`, [roleId, permissionId]);
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "role_permissions",
      recordId: roleId,
      oldValue: { roleId, permissionId },
    });
  });

  return res.status(200).json({ revoked: { roleId, permissionId } });
}));

// ------------------------------------------------------------
// Employee <-> role assignment.
// ------------------------------------------------------------
router.get("/employees/:employeeId", requirePermission("admin.rbac.view"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const [roles, permissions] = await Promise.all([
    getEmployeeRoles(employeeId),
    getEmployeeEffectivePermissions(employeeId),
  ]);
  return res.status(200).json({ employeeId, roles, permissions });
}));

router.post("/employees/:employeeId", requirePermission("admin.rbac.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { roleId } = req.body ?? {};
  if (!roleId) return res.status(400).json({ error: "roleId is required." });

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into user_roles (employee_id, role_id, assigned_by) values ($1, $2, $3)
         on conflict do nothing returning *`,
        [employeeId, roleId, req.user?.userId ?? null],
      );
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "user_roles",
        recordId: employeeId,
        newValue: { employeeId, roleId, assigned: rows.length > 0 },
      });
      return { employeeId, roleId };
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23503") {
      return res.status(404).json({ error: "Employee or role does not exist." });
    }
    throw err;
  }
}));

router.delete("/employees/:employeeId/:roleId", requirePermission("admin.rbac.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const roleId = Number(req.params.roleId);

  await withTransaction(async (client) => {
    await client.query(`delete from user_roles where employee_id = $1 and role_id = $2`, [employeeId, roleId]);
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "user_roles",
      recordId: employeeId,
      oldValue: { employeeId, roleId },
    });
  });

  return res.status(200).json({ revoked: { employeeId, roleId } });
}));

export default router;

// Read-only permissions catalog, exported as middleware array so
// app.ts can mount it at /api/permissions without a second router
// file for one endpoint. New permission codes are only ever added
// by a module's own schema migration (see the insert at the bottom
// of schema-hr-masters.sql), never through this API — so the catalog
// always matches what code actually checks for.
export const permissionsCatalogHandler = [
  requirePermission("admin.rbac.view"),
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await query(`select * from permissions order by module, permission_code`);
    return res.status(200).json(rows);
  }),
];
