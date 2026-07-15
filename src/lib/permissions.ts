import type { Request, Response, NextFunction } from "express";

/**
 * Ruddhaa ERP — Permission Matrix
 *
 * Level model: 'none' < 'read' < 'write'. 'write' implies 'read' — a
 * role that can write to a module can always read it too, so the
 * matrix only needs to state the highest level per module.
 *
 * Modules correspond exactly to the real mounted route prefixes in
 * app.ts — not an abstraction invented for this layer. 'reports' has
 * no write concept at all (there is no POST route anywhere under
 * /api/reports), so 'write' is meaningless for it; every role that
 * can see accounting data at all gets 'read' there.
 *
 * This is the FIRST cut of a real permission system, not a finished
 * one. Two things are intentionally out of scope, stated here rather
 * than hidden: (1) there is no per-project role scoping yet (a
 * project_manager can act on every project, not just ones they're a
 * member of) — project_members.role is a separate, existing concept
 * this doesn't yet connect to; (2) there is no admin UI/API to change
 * an employee's role after creation — that would be a new feature,
 * out of scope for this pass, which is about authorization
 * enforcement, not role management tooling.
 */

export type Role = "super_admin" | "admin" | "accountant" | "project_manager" | "hr" | "sales" | "viewer";
export type PermissionLevel = "none" | "read" | "write";

export const MODULES = [
  "chart-of-accounts",
  "financial-years",
  "journal-entries",
  "reports",
  "customers",
  "vendors",
  "sales-invoices",
  "purchase-invoices",
  "receipts",
  "payments",
  "contra",
  "credit-notes",
  "debit-notes",
  "bank-import",
  "bank-accounts",
  "projects",
  "project-categories",
  "employees",
  "inventory",
  "customer-requests",
  "costing",
  "crm",
  "audit-log",
] as const;
export type Module = typeof MODULES[number];

const FULL_ACCESS: Record<Module, PermissionLevel> = Object.fromEntries(
  MODULES.map((m) => [m, "write"]),
) as Record<Module, PermissionLevel>;

/**
 * The matrix itself. Read this top-to-bottom as the actual policy —
 * every route's permission check ultimately reduces to a lookup here.
 */
export const PERMISSION_MATRIX: Record<Role, Record<Module, PermissionLevel>> = {
  // super_admin and admin are functionally identical today — kept as
  // two distinct roles because a real deployment will likely want to
  // separate "can do everything" from "can also manage other admins"
  // once role-management tooling exists (out of scope here, see
  // above). Until then, treating them differently would be
  // inventing a distinction this system doesn't actually enforce.
  super_admin: FULL_ACCESS,
  admin: FULL_ACCESS,

  accountant: {
    "chart-of-accounts": "write",
    "financial-years": "write",
    "journal-entries": "write",
    reports: "read",
    customers: "write",
    vendors: "write",
    "sales-invoices": "write",
    "purchase-invoices": "write",
    receipts: "write",
    payments: "write",
    contra: "write",
    "credit-notes": "write",
    "debit-notes": "write",
    "bank-import": "write",
    "bank-accounts": "write",
    projects: "read",
    "project-categories": "read",
    employees: "read",
    inventory: "read",
    "customer-requests": "read",
    costing: "read",
    crm: "none",
    "audit-log": "none",
  },

  project_manager: {
    "chart-of-accounts": "read",
    "financial-years": "read",
    "journal-entries": "read",
    reports: "read",
    customers: "read",
    vendors: "read",
    "sales-invoices": "read",
    "purchase-invoices": "read",
    receipts: "read",
    payments: "read",
    contra: "read",
    "credit-notes": "read",
    "debit-notes": "read",
    "bank-import": "read",
    "bank-accounts": "read",
    projects: "write",
    "project-categories": "write",
    employees: "read",
    inventory: "read",
    "customer-requests": "read",
    costing: "write",
    crm: "read",
    "audit-log": "none",
  },

  // HR has almost nothing today because there is almost nothing to
  // have permissions over — no HR module exists yet (it's being built
  // as a separate, independent stream — see the architecture reference
  // handed to that effort). 'employees' read is the one real thing
  // this role can legitimately do right now. Everything else is
  // 'none' deliberately, not 'read' — least privilege, not a
  // placeholder guess at what HR might eventually need.
  hr: {
    "chart-of-accounts": "none",
    "financial-years": "none",
    "journal-entries": "none",
    reports: "none",
    customers: "none",
    vendors: "none",
    "sales-invoices": "none",
    "purchase-invoices": "none",
    receipts: "none",
    payments: "none",
    contra: "none",
    "credit-notes": "none",
    "debit-notes": "none",
    "bank-import": "none",
    "bank-accounts": "none",
    projects: "none",
    "project-categories": "none",
    employees: "read",
    inventory: "none",
    "customer-requests": "none",
    costing: "none",
    crm: "none",
    "audit-log": "none",
  },

  sales: {
    "chart-of-accounts": "read",
    "financial-years": "read",
    "journal-entries": "read",
    reports: "read",
    customers: "write",
    vendors: "read",
    "sales-invoices": "write",
    "purchase-invoices": "read",
    receipts: "write",
    payments: "read",
    contra: "read",
    "credit-notes": "write",
    "debit-notes": "read",
    "bank-import": "read",
    "bank-accounts": "read",
    projects: "read",
    "project-categories": "read",
    employees: "read",
    inventory: "read",
    "customer-requests": "write",
    costing: "read",
    crm: "write",
    "audit-log": "none",
  },

  viewer: Object.fromEntries(MODULES.map((m) => [m, "read"])) as Record<Module, PermissionLevel>,
};

export function hasPermission(role: string, module: Module, required: "read" | "write"): boolean {
  const roleMatrix = PERMISSION_MATRIX[role as Role];
  if (!roleMatrix) return false; // unknown role — fail closed, not open
  const level = roleMatrix[module];
  if (level === "write") return true;
  if (level === "read") return required === "read";
  return false;
}

/**
 * Route middleware factory. Must run after requireAuth (needs
 * req.user, specifically req.user.role, to already be populated).
 * Fails closed: a missing/unrecognized role is denied, never allowed
 * through on the assumption it's probably fine.
 */
export function requirePermission(module: Module, required: "read" | "write") {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !hasPermission(role, module, required)) {
      return res.status(403).json({
        error: `Your role ('${role ?? "unknown"}') does not have ${required} access to ${module}.`,
      });
    }
    next();
  };
}
