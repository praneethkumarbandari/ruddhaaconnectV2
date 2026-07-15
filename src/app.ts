import express from "express";
import cors from "cors";
import { requireAuth } from "./middleware/auth.ts";
import { tenantContextMiddleware, tenantContextErrorHandler } from "./middleware/tenant-context.ts";

// ------------------------------------------------------------
// Accounting core + Bank Import + Project Management (unchanged from
// the frozen Accounting V1.1 / PM integration — these route files are
// the newer, project-tagged versions; see each file's own comments).
// ------------------------------------------------------------
import authRoutes from "./routes/auth.ts";
import numberingRoutes from "./routes/numbering.ts";
import auditLogRoutes from "./routes/audit-log.ts";
import gstFilingRoutes from "./routes/gst-filing.ts";
import tdsRoutes from "./routes/tds.ts";
import setupRoutes from "./routes/setup.ts";
import googleDriveSetupRoutes from "./routes/google-drive-setup.ts";
import chartOfAccountsRoutes from "./routes/chart-of-accounts.ts";
import ledgersRoutes from "./routes/ledgers.ts";
import searchRoutes from "./routes/search.ts";
import documentTemplatesRoutes from "./routes/document-templates.ts";
import projectTemplatesRoutes from "./routes/project-templates.ts";
import projectHierarchyRoutes from "./routes/project-hierarchy.ts";
import financialYearsRoutes from "./routes/financial-years.ts";
import journalEntriesRoutes from "./routes/journal-entries.ts";
import reportsRoutes from "./routes/reports.ts";
import dashboardRoutes from "./routes/dashboard.ts";
import settingsRoutes from "./routes/settings.ts";
import customersRoutes from "./routes/customers.ts";
import vendorsRoutes from "./routes/vendors.ts";
import salesInvoicesRoutes from "./routes/sales-invoices.ts";
import purchaseInvoicesRoutes from "./routes/purchase-invoices.ts";
import receiptsRoutes from "./routes/receipts.ts";
import paymentsRoutes from "./routes/payments.ts";
import contraRoutes from "./routes/contra.ts";
import bankImportRoutes from "./routes/bank-import.ts";
import projectsRoutes from "./routes/projects.ts";
import projectCategoriesRoutes from "./routes/project-categories.ts";
import employeesRoutes from "./routes/employees.ts";
import { creditNoteRouter, debitNoteRouter } from "./routes/notes.ts";
import inventoryRoutes from "./routes/inventory.ts";
import bankAccountsRoutes from "./routes/bank-accounts.ts";
import customerRequestsRoutes from "./routes/customer-requests.ts";
import costingRoutes from "./routes/costing.ts";
import crmRoutes from "./routes/crm.ts";

// ------------------------------------------------------------
// Customer Portal auth — fixes the previous customer-login.html,
// which authenticated directly against Supabase from the browser and
// compared/stored plaintext passwords. Deliberately separate from the
// employee `authRoutes`/`requireAuth` below: customer sessions use a
// different token scope (see lib/customer-auth.ts) and must never be
// interchangeable with an employee session.
// ------------------------------------------------------------
import customerPortalAuthRoutes from "./routes/customer-portal-auth.ts";
import customerPortalDataRoutes from "./routes/customer-portal-data.ts";

// ------------------------------------------------------------
// ERP-wide RBAC administration (roles, permissions, employee<->role
// assignment). Gated by admin.rbac.* inside routes/roles.ts, not by
// module — this is infrastructure, not an accounting or HR endpoint.
// ------------------------------------------------------------
import rolesRoutes, { permissionsCatalogHandler } from "./routes/roles.ts";

// ------------------------------------------------------------
// HR MODULE — Milestone 1 (master data)
// ------------------------------------------------------------
import departmentsRoutes from "./routes/hr/departments.ts";
import designationsRoutes from "./routes/hr/designations.ts";
import employmentTypesRoutes from "./routes/hr/employment-types.ts";
import branchesRoutes from "./routes/hr/branches.ts";
import costCentersRoutes from "./routes/hr/cost-centers.ts";
import shiftsRoutes from "./routes/hr/shifts.ts";
import holidaysRoutes from "./routes/hr/holidays.ts";
import salaryComponentsRoutes from "./routes/hr/salary-components.ts";
import salaryStructuresRoutes from "./routes/hr/salary-structures.ts";
import leaveTypesRoutes from "./routes/hr/leave-types.ts";
import attendanceStatusesRoutes from "./routes/hr/attendance-statuses.ts";
import documentTypesRoutes from "./routes/hr/document-types.ts";

// HR MODULE — Milestone 2 (Employee Master + Profile)
import hrEmployeesRoutes from "./routes/hr/employees.ts";
import employeeProfileRoutes from "./routes/hr/employee-profile.ts";
import employeeSensitiveRoutes from "./routes/hr/employee-sensitive.ts";
import employeeDocumentsRoutes from "./routes/hr/employee-documents.ts";
import employeeAssetsRoutes from "./routes/hr/employee-assets.ts";

// HR MODULE — Milestone 3 (Attendance Engine)
import attendancePoliciesRoutes from "./routes/attendance/policies.ts";
import shiftAssignmentsRoutes from "./routes/attendance/shift-assignments.ts";
import weeklyOffRoutes from "./routes/attendance/weekly-off.ts";
import shiftOverridesRoutes from "./routes/attendance/shift-overrides.ts";
import attendanceImportRoutes from "./routes/attendance/import.ts";
import attendanceRecordsRoutes from "./routes/attendance/records.ts";
import attendanceCorrectionsRoutes from "./routes/attendance/corrections.ts";
import attendanceLocksRoutes from "./routes/attendance/locks.ts";
import attendanceReportsRoutes from "./routes/attendance/reports.ts";

// HR MODULE — Milestone 4 (Leave Management)
import leavePoliciesRoutes from "./routes/leave/policies.ts";
import leaveYearConfigRoutes from "./routes/leave/year-config.ts";
import leaveBalancesRoutes from "./routes/leave/balances.ts";
import leaveRequestsRoutes from "./routes/leave/requests.ts";
import leaveReportsRoutes from "./routes/leave/reports.ts";

// HR MODULE — Milestone 5 (Payroll Engine)
import payrollSalaryAssignmentsRoutes from "./routes/payroll/salary-structure-assignments.ts";
import payrollStatutoryRulesRoutes from "./routes/payroll/statutory-rules.ts";
import payrollAccountMappingsRoutes from "./routes/payroll/account-mappings.ts";
import payrollLoansRoutes from "./routes/payroll/loans.ts";
import payrollReimbursementsRoutes from "./routes/payroll/reimbursements.ts";
import payrollRunsRoutes from "./routes/payroll/runs.ts";
import payrollPostingRoutes from "./routes/payroll/posting.ts";
import payrollReportsRoutes from "./routes/payroll/reports.ts";

export const app = express();

// FIX (found during review of the rate-limiting fix itself): no
// 'trust proxy' setting existed. express-rate-limit's own validation
// flags this as a misconfiguration risk (confirmed live: it logs
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR the moment a request arrives with
// an X-Forwarded-For header while trust proxy is unset). This app is
// explicitly designed to run behind a reverse proxy (see db/pool.ts's
// small connection pool, sized for Netlify Functions) -- without this,
// every request arriving through that proxy reports the SAME IP to
// Express, so the rate limits added elsewhere in this file would apply
// to ALL real users behind that proxy collectively, not each one
// individually. A handful of employees logging in around the same
// time could lock each other out of a login endpoint none of them
// were actually abusing.
//
// TRUST_PROXY_HOPS defaults to 1 (trust exactly one layer of proxying —
// the standard, safe default for a typical PaaS/serverless front door
// like Netlify's), but is configurable since the exact topology depends
// on the real deployment target, which this codebase can't assume with
// certainty.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? "1");
app.set("trust proxy", trustProxyHops);

// FIX (production-readiness re-audit): cors() with no options allows
// ANY origin — fine while this was an internal tool, not appropriate
// now that customer-facing auth endpoints exist. ALLOWED_ORIGINS is a
// comma-separated list (e.g. "https://app.example.com,https://portal.example.com").
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// FIX (checklist item #6, "should-fix"): this used to fall back to
// permissive with only a console.warn — easy to miss in Netlify's
// function logs, and a genuinely open CORS policy on a customer-
// facing auth API is worse than most single silent bugs. Netlify
// sets CONTEXT=production automatically on the real production
// deploy (not previews, not branch deploys, not local) — no new env
// var needed from you to detect this. In production specifically,
// missing ALLOWED_ORIGINS now refuses to boot at all, same fail-loud
// pattern JWT_SECRET already uses (see lib/jwt.ts's requireSecret()).
// Non-production contexts keep the permissive fallback with a
// warning, so local dev and preview deploys aren't blocked by this.
if (allowedOrigins.length === 0) {
  if (process.env.CONTEXT === "production") {
    throw new Error(
      "ALLOWED_ORIGINS is not set in production. Refusing to start with CORS " +
      "open to any origin on a customer-facing API. Set ALLOWED_ORIGINS " +
      "(comma-separated, e.g. \"https://ruddhaa.netlify.app\") in Netlify's " +
      "environment variables and redeploy.",
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    "ALLOWED_ORIGINS is not set — CORS is currently allowing ALL origins. " +
    "This is fine for local dev/preview deploys, but production will refuse " +
    "to start without it set (see app.ts).",
  );
}

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  credentials: true,
}));
app.use(express.json());

app.get("/api/health", (_req, res) =>
  res.status(200).json({
    status: "ok",
    modules: ["accounting", "bank-import", "project-management", "rbac", "hr", "attendance", "leave", "payroll"],
  }),
);

// Login is the only route that doesn't require a token, for obvious reasons.
app.use("/api/auth", authRoutes);

// ONE-TIME setup bootstrap (create the first admin employee). Public
// by necessity — no employee JWT can exist yet before this runs. Its
// own internal checks (SETUP_TOKEN + "refuses if any employee already
// exists") are what keep this safe to leave mounted, not route
// placement. Remove this route entirely once used.
app.use("/api/setup", setupRoutes);
app.use("/api/google-drive", googleDriveSetupRoutes);

// Customer portal auth (login/OTP/reset) is equally public — a
// customer has no employee JWT to present yet. Mounted before the
// blanket requireAuth gate below, same reasoning as /api/auth.
// /me is the one route inside this router that needs a session, and
// it guards itself with requireCustomerAuth directly rather than
// relying on the employee-only gate that follows.
app.use("/api/auth/customer", customerPortalAuthRoutes);

// Customer-facing data endpoints (payment history, request submission).
// Guards itself with requireCustomerAuth internally (applied via
// router.use inside customer-portal-data.ts), same reasoning as the
// auth router above: a customer token is a different scope entirely
// from an employee JWT and must be checked before the blanket
// employee-only gate below, not instead of any check at all.
app.use("/api/customer-portal", customerPortalDataRoutes);

// Everything past this point requires a valid EMPLOYEE JWT. Customer
// portal sessions are a different token scope entirely (see
// lib/customer-auth.ts) and are intentionally rejected by requireAuth.
app.use("/api", requireAuth);
app.use("/api", tenantContextMiddleware);

// ------------------------------------------------------------
// Accounting core (posting-engine backed) + Bank Import
// ------------------------------------------------------------
app.use("/api/chart-of-accounts", chartOfAccountsRoutes);
app.use("/api/ledgers", ledgersRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/document-templates", documentTemplatesRoutes);
app.use("/api/project-templates", projectTemplatesRoutes);
app.use("/api/project-hierarchy", projectHierarchyRoutes);
app.use("/api/numbering", numberingRoutes);
app.use("/api/audit-log", auditLogRoutes);
app.use("/api/gst-filing", gstFilingRoutes);
app.use("/api/tds", tdsRoutes);
app.use("/api/financial-years", financialYearsRoutes);
app.use("/api/journal-entries", journalEntriesRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/vendors", vendorsRoutes);
app.use("/api/sales-invoices", salesInvoicesRoutes);
app.use("/api/purchase-invoices", purchaseInvoicesRoutes);
app.use("/api/receipts", receiptsRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/contra", contraRoutes);
app.use("/api/credit-notes", creditNoteRouter);
app.use("/api/debit-notes", debitNoteRouter);
app.use("/api/bank-import", bankImportRoutes);

// ------------------------------------------------------------
// Project Management
// ------------------------------------------------------------
app.use("/api/projects", projectsRoutes);
app.use("/api/project-categories", projectCategoriesRoutes);

// Read-only employee picker (Project Management's Team tab) — NOT
// employee management. Deliberately kept separate from /api/hr/employees
// below; see routes/employees.ts's own comment for why the two coexist.
app.use("/api/employees", employeesRoutes);

// ------------------------------------------------------------
// Architecture migration additions (Inventory, Bank Accounts, Customer
// Requests, Costing, CRM) — see the Architecture Migration Report.
// Each replaces a previously direct-Supabase content page with a real
// Express route -> service -> database path, using the exact same
// data shapes and behavior the frontend already depended on.
// ------------------------------------------------------------
app.use("/api/inventory", inventoryRoutes);
app.use("/api/bank-accounts", bankAccountsRoutes);
app.use("/api/customer-requests", customerRequestsRoutes);
app.use("/api/costing", costingRoutes);
app.use("/api/crm", crmRoutes);

// ------------------------------------------------------------
// ERP-wide RBAC administration (roles, permissions, employee<->role
// assignment). Gated by admin.rbac.* inside routes/roles.ts, not by
// module — this is infrastructure, not an accounting or HR endpoint.
// ------------------------------------------------------------
app.use("/api/roles", rolesRoutes);
app.get("/api/permissions", ...permissionsCatalogHandler);

// ------------------------------------------------------------
// HR MODULE — MILESTONE 1 (master data only; Employee Master itself
// is Milestone 2, see the scope note at the top of
// src/db/schema-hr-masters.sql). Every route below is gated by its
// own hr.<resource>.view/.manage permission via requirePermission()
// (src/middleware/permission.ts), the DB-driven RBAC system — a
// separate, parallel permission system from the static role-matrix
// used above by Accounting/Bank Import/Project Management
// (src/lib/permissions.ts). See src/lib/rbac-permissions.ts for the
// engine both routes/roles.ts and middleware/permission.ts share.
// ------------------------------------------------------------
app.use("/api/hr/departments", departmentsRoutes);
app.use("/api/hr/designations", designationsRoutes);
app.use("/api/hr/employment-types", employmentTypesRoutes);
app.use("/api/hr/branches", branchesRoutes);
app.use("/api/hr/cost-centers", costCentersRoutes);
app.use("/api/hr/shifts", shiftsRoutes);
app.use("/api/hr/holidays", holidaysRoutes);
app.use("/api/hr/salary-components", salaryComponentsRoutes);
app.use("/api/hr/salary-structures", salaryStructuresRoutes);
app.use("/api/hr/leave-types", leaveTypesRoutes);
app.use("/api/hr/attendance-statuses", attendanceStatusesRoutes);
app.use("/api/hr/document-types", documentTypesRoutes);

// ------------------------------------------------------------
// HR MODULE — MILESTONE 2 (Employee Master + Profile). Mounted after
// the base /api/hr/employees router so its own /, /:id, /:id/org-tree,
// /:id/manager-chain routes are matched first — the sub-resource
// routers below only ever get reached for paths hrEmployeesRoutes
// doesn't define (e.g. /:employeeId/addresses), via mergeParams.
// Bank/statutory are a separate router (employeeSensitiveRoutes) on
// the same path prefix specifically so their stricter
// hr.employee.sensitive.* gate is visible per-file, not just per-line.
// ------------------------------------------------------------
app.use("/api/hr/employees", hrEmployeesRoutes);
app.use("/api/hr/employees/:employeeId", employeeProfileRoutes);
app.use("/api/hr/employees/:employeeId", employeeSensitiveRoutes);
app.use("/api/hr/employees/:employeeId/documents", employeeDocumentsRoutes);
app.use("/api/hr/employees/:employeeId/assets", employeeAssetsRoutes);

// ------------------------------------------------------------
// HR MODULE — MILESTONE 3 (Attendance Engine). Masters + biometric
// import + records + corrections + locks + reports, all gated by
// their own attendance.* permissions (schema-attendance.sql). The
// correction workflow consumes the generic approval framework
// (lib/approvals.ts) via lib/attendance-corrections.ts.
// ------------------------------------------------------------
app.use("/api/attendance/policies", attendancePoliciesRoutes);
app.use("/api/attendance/shift-assignments", shiftAssignmentsRoutes);
app.use("/api/attendance/weekly-off", weeklyOffRoutes);
app.use("/api/attendance/shift-overrides", shiftOverridesRoutes);
app.use("/api/attendance/import", attendanceImportRoutes);
app.use("/api/attendance/records", attendanceRecordsRoutes);
app.use("/api/attendance/corrections", attendanceCorrectionsRoutes);
app.use("/api/attendance/locks", attendanceLocksRoutes);
app.use("/api/attendance/reports", attendanceReportsRoutes);

// ------------------------------------------------------------
// HR MODULE — MILESTONE 4 (Leave Management). Reuses the Attendance
// Engine's lock check, employment-date validation, and department/
// branch snapshot helpers; reuses lib/approvals.ts for the approval
// workflow; does not duplicate leave_types, holidays, or
// weekly_off_configurations, all from earlier milestones.
// ------------------------------------------------------------
app.use("/api/leave/policies", leavePoliciesRoutes);
app.use("/api/leave/year-config", leaveYearConfigRoutes);
app.use("/api/leave/balances", leaveBalancesRoutes);
app.use("/api/leave/requests", leaveRequestsRoutes);
app.use("/api/leave/reports", leaveReportsRoutes);

// ------------------------------------------------------------
// HR MODULE — MILESTONE 5 (Payroll Engine). Reads Attendance and
// Leave; never duplicates their data. Posts to Accounting exclusively
// through the existing postJournalEntry() — see
// PAYROLL_ACCOUNTING_INTEGRATION.md for the one additive change this
// required (extending posting-engine.ts's sourceType union, merged
// alongside Project Management's own projectId addition) and the full
// posting design.
// ------------------------------------------------------------
app.use("/api/payroll/salary-structure-assignments", payrollSalaryAssignmentsRoutes);
app.use("/api/payroll/statutory-rules", payrollStatutoryRulesRoutes);
app.use("/api/payroll/account-mappings", payrollAccountMappingsRoutes);
app.use("/api/payroll/loans", payrollLoansRoutes);
app.use("/api/payroll/reimbursements", payrollReimbursementsRoutes);
app.use("/api/payroll/runs", payrollRunsRoutes);
app.use("/api/payroll/posting", payrollPostingRoutes);
app.use("/api/payroll/reports", payrollReportsRoutes);

app.use(tenantContextErrorHandler);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});
