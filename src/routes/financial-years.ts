import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "../lib/audit.ts";
import { postOpeningBalances } from "../lib/posting-engine.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("financial-years.view"));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from financial_years order by start_date desc`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("financial-years.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { code, startDate, endDate } = req.body ?? {};
  if (!code || !startDate || !endDate) {
    return res.status(400).json({ error: "code, startDate, and endDate are required." });
  }
  if (new Date(startDate) >= new Date(endDate)) {
    return res.status(422).json({ error: "startDate must be before endDate." });
  }

  try {
    const { rows } = await query(
      `insert into financial_years (code, start_date, end_date) values ($1, $2, $3) returning *`,
      [code, startDate, endDate],
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      return res.status(409).json({ error: `Financial year code "${code}" already exists.` });
    }
    if (pgErr.code === "23P01") {
      return res.status(409).json({ error: "This date range overlaps an existing financial year." });
    }
    throw err;
  }
}));

/**
 * Closing a financial year is a one-way gate for new postings dated
 * inside it (requireOpenFinancialYear() in lib/fy.ts checks this on
 * every single posting). Reopening is intentionally a separate,
 * explicit action — never implicit, never automatic.
 */
router.post("/:id/close", requirePermission("financial-years.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from financial_years where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update financial_years set status = 'closed' where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "financial_year",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Financial year not found." });
  return res.status(200).json(result);
}));

router.post("/:id/reopen", requirePermission("financial-years.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from financial_years where id = $1`, [id]);
    if (existing.length === 0) return null;

    const { rows } = await client.query(
      `update financial_years set status = 'open' where id = $1 returning *`,
      [id],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "financial_year",
      recordId: id,
      oldValue: existing[0],
      newValue: rows[0],
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Financial year not found." });
  return res.status(200).json(result);
}));

/**
 * Sets or clears an interim accounting-period lock — separate from,
 * and in addition to, the whole-year close above. See
 * schema-financial-years-period-lock.sql and requireOpenFinancialYear()
 * in lib/fy.ts for what this actually enforces: entries dated on or
 * before lockedThroughDate are rejected even while the financial year
 * itself remains 'open'. Pass lockedThroughDate: null to clear the
 * lock (e.g. a filed GST period turned out to need a correction).
 */
router.post("/:id/lock-period", requirePermission("financial-years.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { lockedThroughDate } = req.body ?? {};
  if (lockedThroughDate !== null && !lockedThroughDate) {
    return res.status(400).json({ error: "lockedThroughDate is required (or explicitly null to clear the lock)." });
  }

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from financial_years where id = $1`, [id]);
    if (existing.length === 0) return null;

    if (lockedThroughDate !== null) {
      if (new Date(lockedThroughDate) < new Date(existing[0].start_date) || new Date(lockedThroughDate) >= new Date(existing[0].end_date)) {
        throw new Error("lockedThroughDate must fall within the financial year's own date range, and can't cover the entire year (close the year instead).");
      }
    }

    const { rows } = await client.query(
      `update financial_years set locked_through_date = $2 where id = $1 returning *`,
      [id, lockedThroughDate],
    );
    await writeAudit(client, {
      userId: req.user?.userId ?? null,
      action: "update",
      module: "financial_year",
      recordId: id,
      oldValue: { locked_through_date: existing[0].locked_through_date },
      newValue: { locked_through_date: rows[0].locked_through_date },
    });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Financial year not found." });
  return res.status(200).json(result);
}));

/**
 * Posts every active account's stored opening_balance into the
 * ledger for this financial year, as one balanced journal entry
 * dated the FY's start date. See postOpeningBalances() in
 * lib/posting-engine.ts for why this exists — without it,
 * opening_balance on chart_of_accounts is inert and every report
 * silently starts from zero.
 */
router.post("/:id/post-opening-balances", requirePermission("financial-years.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  try {
    const result = await withTransaction((client) => postOpeningBalances(client, id, req.user?.userId ?? null));
    if ("skipped" in result) {
      return res.status(200).json(result);
    }
    return res.status(201).json(result);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (message.includes("not found")) {
      return res.status(404).json({ error: message });
    }
    // Both "already posted" and an unbalanced opening trial balance
    // are expected business-rule rejections, not system failures.
    return res.status(422).json({ error: message });
  }
}));

export default router;
