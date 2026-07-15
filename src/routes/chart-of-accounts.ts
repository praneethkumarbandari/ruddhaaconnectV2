import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "../lib/audit.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("chart-of-accounts.view"));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(
    `select * from chart_of_accounts order by account_code`,
  );
  return res.status(200).json(rows);
}));

// FIX: replaces the old, disconnected "Account Mapping" settings
// screen — pick an account's specific role right here, when creating
// or editing it, instead of a second screen that had no real link to
// the accounts it was supposedly describing.
const SPECIAL_ROLES = [
  "sundry_debtors", "sales", "discount_allowed", "sundry_creditors",
  "purchases", "discount_received", "freight", "gst_output", "gst_input",
  "tds_payable", "tds_receivable", "tcs", "cash", "round_off",
  "opening_balance_equity", "inventory_adjustment", "salary_payable",
];

router.post("/", requirePermission("chart-of-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { accountCode, accountName, accountType, parentId, openingBalance, openingType, specialRole } = req.body ?? {};

  if (!accountCode || !accountName || !accountType) {
    return res.status(400).json({ error: "accountCode, accountName, and accountType are required." });
  }
  const validTypes = ["asset", "liability", "equity", "income", "expense"];
  if (!validTypes.includes(accountType)) {
    return res.status(400).json({ error: `accountType must be one of: ${validTypes.join(", ")}` });
  }
  if (specialRole && !SPECIAL_ROLES.includes(specialRole)) {
    return res.status(400).json({ error: `specialRole must be one of: ${SPECIAL_ROLES.join(", ")}` });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into chart_of_accounts (account_code, account_name, account_type, parent_id, opening_balance, opening_type, special_role, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         returning *`,
        [accountCode, accountName, accountType, parentId ?? null, openingBalance ?? 0, openingType ?? "debit", specialRole ?? null, req.user?.userId ?? null],
      );
      const account = rows[0];
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "create",
        module: "chart_of_accounts",
        recordId: account.id,
        newValue: account,
      });
      return account;
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      if (String((err as { constraint?: string }).constraint || "").includes("special_role")) {
        return res.status(409).json({ error: `Another account already has the "${specialRole}" role. Only one account can hold each role.` });
      }
      return res.status(409).json({ error: `Account code "${accountCode}" already exists.` });
    }
    throw err;
  }
}));

// Editing an account's name/type/special role — this account list
// never had an edit path before, only create + deactivate.
router.patch("/:id", requirePermission("chart-of-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { accountName, accountType, specialRole } = req.body ?? {};
  if (specialRole && !SPECIAL_ROLES.includes(specialRole)) {
    return res.status(400).json({ error: `specialRole must be one of: ${SPECIAL_ROLES.join(", ")}` });
  }
  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`select * from chart_of_accounts where id = $1`, [id]);
      if (existing.length === 0) throw Object.assign(new Error("Account not found."), { status: 404 });
      const { rows } = await client.query(
        `update chart_of_accounts
         set account_name = coalesce($2, account_name),
             account_type = coalesce($3, account_type),
             special_role = $4, updated_by = $5, updated_at = now()
         where id = $1
         returning *`,
        [id, accountName ?? null, accountType ?? null, specialRole ?? null, req.user?.userId ?? null],
      );
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "update",
        module: "chart_of_accounts",
        recordId: id,
        oldValue: existing[0],
        newValue: rows[0],
      });
      return rows[0];
    });
    return res.status(200).json(result);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return res.status(404).json({ error: (err as Error).message });
    if ((err as { code?: string }).code === "23505" && String((err as { constraint?: string }).constraint || "").includes("special_role")) {
      return res.status(409).json({ error: `Another account already has the "${specialRole}" role. Only one account can hold each role.` });
    }
    throw err;
  }
}));

/**
 * Deactivate only. There is no DELETE route on this resource —
 * accounts are never deleted, per the chart-of-accounts rule, because
 * historical journal_entry_lines reference them permanently.
 */
router.post("/:id/deactivate", requirePermission("chart-of-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  try {
    const result = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(
        `select * from chart_of_accounts where id = $1`,
        [id],
      );
      if (existing.length === 0) return null;
      if (existing[0].is_system) {
        // Thrown as a distinct, caught error rather than a generic
        // exception — this is an expected business rule violation,
        // not a system failure, and must not be reported to the
        // caller as a 500.
        throw new SystemAccountError(existing[0].account_code);
      }

      const { rows } = await client.query(
        `update chart_of_accounts set is_active = false, updated_at = now() where id = $1 returning *`,
        [id],
      );
      await writeAudit(client, {
        userId: req.user?.userId ?? null,
        action: "deactivate",
        module: "chart_of_accounts",
        recordId: id,
        oldValue: existing[0],
        newValue: rows[0],
      });
      return rows[0];
    });

    if (!result) return res.status(404).json({ error: "Account not found." });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof SystemAccountError) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }
}));

class SystemAccountError extends Error {
  constructor(accountCode: string) {
    super(`Account ${accountCode} is a system account and cannot be deactivated.`);
    this.name = "SystemAccountError";
  }
}

export default router;
