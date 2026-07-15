import type { PgClient } from "../db/pool.ts";
import { pool, query } from "../db/pool.ts";
import { getManagerChain } from "./employees.ts";

/**
 * Generic approval resolution — implements the "Approval Resolution"
 * contract specified in SHARED_SERVICE_CONTRACTS.md §7 during the ERP
 * Integration Readiness Review, before any code consumed it. This is
 * that first real consumer's dependency: Attendance Corrections calls
 * this, not the other way around, and this file has no knowledge of
 * attendance, leave, or any other specific workflow — exactly the
 * same module-independence discipline as lib/permissions.ts.
 */

export class HierarchyNotFoundError extends Error {
  constructor(hierarchyCode: string) {
    super(`Approval hierarchy '${hierarchyCode}' not found.`);
    this.name = "HierarchyNotFoundError";
  }
}

export class NoReportingManagerError extends Error {
  constructor(employeeId: number) {
    super(`Employee ${employeeId} has no reporting manager to route this approval to.`);
    this.name = "NoReportingManagerError";
  }
}

export type ResolvedApprovalLevel = {
  levelOrder: number;
  approverType: "role" | "reporting_manager";
  approverRoleId: number | null;
  /** Only populated for approverType 'reporting_manager' — the specific employee resolved for this requester. */
  resolvedApproverEmployeeId: number | null;
  isFinalLevel: boolean;
};

/**
 * Resolves the approver for the level AFTER `currentLevelOrder` (pass
 * 0 to resolve the first level of a fresh request). Per the contract:
 * a 'reporting_manager' level is resolved to a specific employee here
 * — the caller never resolves that themselves. Throws
 * NoReportingManagerError (a distinct, named error, per the contract)
 * rather than returning a null approver silently, since a requester
 * with no manager in the org chart is a real, actionable data
 * problem, not a normal empty result.
 */
export async function resolveNextApprovalLevel(
  hierarchyCode: string,
  requesterEmployeeId: number,
  currentLevelOrder: number,
): Promise<ResolvedApprovalLevel | null> {
  const { rows: hierarchyRows } = await query(
    `select id from approval_hierarchies where hierarchy_code = $1 and is_active = true`,
    [hierarchyCode],
  );
  if (hierarchyRows.length === 0) throw new HierarchyNotFoundError(hierarchyCode);
  const hierarchyId = hierarchyRows[0].id;

  const { rows: levels } = await query(
    `select level_order, approver_type, approver_role_id
     from approval_hierarchy_levels
     where hierarchy_id = $1
     order by level_order`,
    [hierarchyId],
  );
  if (levels.length === 0) return null; // no levels configured — nothing to approve against

  const nextLevel = levels.find((l) => l.level_order > currentLevelOrder);
  if (!nextLevel) return null; // already past the last configured level

  const isFinalLevel = !levels.some((l) => l.level_order > nextLevel.level_order);

  let resolvedApproverEmployeeId: number | null = null;
  if (nextLevel.approver_type === "reporting_manager") {
    const chain = await getManagerChain(requesterEmployeeId);
    if (chain.length === 0) throw new NoReportingManagerError(requesterEmployeeId);
    resolvedApproverEmployeeId = Number(chain[0].employee_id); // depth 1 = direct manager
  }

  return {
    levelOrder: nextLevel.level_order,
    approverType: nextLevel.approver_type,
    approverRoleId: nextLevel.approver_role_id,
    resolvedApproverEmployeeId,
    isFinalLevel,
  };
}

/**
 * True if `approverEmployeeId` is entitled to act on `level` — either
 * they ARE the resolved reporting manager, or they hold the required
 * role (checked via user_roles directly here rather than importing
 * employeeHasPermission, since this is a role-membership check — "are
 * you a holder of this role" — not a permission-code check; the two
 * are related but distinct questions).
 */
export async function isEntitledApprover(client: PgClient, approverEmployeeId: number, level: ResolvedApprovalLevel): Promise<boolean> {
  if (level.approverType === "reporting_manager") {
    return level.resolvedApproverEmployeeId === approverEmployeeId;
  }
  const { rows } = await client.query(
    `select 1 from user_roles where employee_id = $1 and role_id = $2`,
    [approverEmployeeId, level.approverRoleId],
  );
  return rows.length > 0;
}
