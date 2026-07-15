import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

/**
 * Mounted at /api/hr/employees/:employeeId/... (mergeParams). Kept in
 * its own file, separate from employee-profile.ts, specifically
 * because it's gated by hr.employee.sensitive.* rather than
 * hr.employee.* — HR_VIEWER has the latter but not the former (see
 * schema-hr-employee-master.sql's seed comment). Splitting the file
 * makes that permission boundary visible at a glance rather than
 * something you'd only notice by reading every route's middleware arg.
 */
const router = Router({ mergeParams: true });

/**
 * Architecture Review Gate fix: this codebase's writeAudit() always
 * stores the full new_value JSONB (every other module — chart of
 * accounts opening balances, customer GSTINs — logs in full, and
 * that's fine for data that isn't independently sensitive). Bank
 * account numbers and statutory IDs are different: logging them in
 * full into audit_log just creates a second, less-guarded place the
 * same sensitive values live in plaintext. This masks the specific
 * fields that don't need to be reconstructable from history — an
 * audit trail needs to show THAT the account number changed and by
 * whom, not what the old and new numbers actually were. Scoped
 * narrowly to this one file rather than changing writeAudit() itself,
 * since every other caller's "log everything" behavior is correct for
 * what they log and shouldn't change.
 */
function maskTail(value: string | null | undefined, visibleChars = 4): string | null {
  if (!value) return null;
  if (value.length <= visibleChars) return "*".repeat(value.length);
  return "*".repeat(value.length - visibleChars) + value.slice(-visibleChars);
}

function redactBankDetails(row: Record<string, unknown>) {
  return { ...row, account_number: maskTail(row.account_number as string) };
}

function redactStatutoryDetails(row: Record<string, unknown>) {
  return {
    ...row,
    pan_number: maskTail(row.pan_number as string),
    aadhaar_number: maskTail(row.aadhaar_number as string),
  };
}

// ------------------------------------------------------------
// BANK DETAILS (1:1)
// ------------------------------------------------------------
router.get("/bank-details", requirePermission("hr.employee.sensitive.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_bank_details where employee_id = $1`, [req.params.employeeId]);
  return res.status(200).json(rows[0] ?? null);
}));

router.put("/bank-details", requirePermission("hr.employee.sensitive.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { bankName, accountNumber, ifscCode, accountHolderName, branchName } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into employee_bank_details (employee_id, bank_name, account_number, ifsc_code, account_holder_name, branch_name)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (employee_id)
       do update set bank_name = excluded.bank_name, account_number = excluded.account_number,
         ifsc_code = excluded.ifsc_code, account_holder_name = excluded.account_holder_name,
         branch_name = excluded.branch_name, updated_at = now()
       returning *`,
      [employeeId, bankName ?? null, accountNumber ?? null, ifscCode ?? null, accountHolderName ?? null, branchName ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_bank_details", recordId: employeeId, newValue: redactBankDetails(rows[0]) });
    return rows[0];
  });
  return res.status(200).json(result);
}));

// ------------------------------------------------------------
// STATUTORY DETAILS (1:1)
// ------------------------------------------------------------
router.get("/statutory-details", requirePermission("hr.employee.sensitive.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_statutory_details where employee_id = $1`, [req.params.employeeId]);
  return res.status(200).json(rows[0] ?? null);
}));

router.put("/statutory-details", requirePermission("hr.employee.sensitive.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { panNumber, aadhaarNumber, uanNumber, pfNumber, esiNumber, ptApplicable } = req.body ?? {};

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into employee_statutory_details (employee_id, pan_number, aadhaar_number, uan_number, pf_number, esi_number, pt_applicable)
         values ($1,$2,$3,$4,$5,$6,coalesce($7,true))
         on conflict (employee_id)
         do update set pan_number = excluded.pan_number, aadhaar_number = excluded.aadhaar_number,
           uan_number = excluded.uan_number, pf_number = excluded.pf_number, esi_number = excluded.esi_number,
           pt_applicable = excluded.pt_applicable, updated_at = now()
         returning *`,
        [employeeId, panNumber ?? null, aadhaarNumber ?? null, uanNumber ?? null, pfNumber ?? null, esiNumber ?? null, ptApplicable ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_statutory_details", recordId: employeeId, newValue: redactStatutoryDetails(rows[0]) });
      return rows[0];
    });
    return res.status(200).json(result);
  } catch (err) {
    const constraint = (err as { code?: string; constraint?: string }).constraint ?? "";
    if ((err as { code?: string }).code === "23505") {
      if (constraint.includes("pan")) return res.status(409).json({ error: `PAN "${panNumber}" is already recorded for another employee.` });
      if (constraint.includes("aadhaar")) return res.status(409).json({ error: `Aadhaar number is already recorded for another employee.` });
      return res.status(409).json({ error: "A unique statutory identifier is already recorded for another employee." });
    }
    throw err;
  }
}));

export default router;
