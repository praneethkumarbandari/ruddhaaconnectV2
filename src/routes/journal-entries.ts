import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import {
  postJournalEntry,
  reverseJournalEntry,
  validateBalance,
  UnbalancedEntryError,
  InsufficientLinesError,
  UnknownAccountError,
  JournalEntryNotFoundError,
  JournalEntryNotPostedError,
  JournalEntryAlreadyReversedError,
} from "../lib/posting-engine.ts";
import { FinancialYearClosedError, PeriodLockedError, NoFinancialYearError } from "../lib/fy.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("journal-entries.view"));

// Errors the posting engine is expected to throw as normal business-rule
// rejections. Anything NOT in this list is treated as an unexpected
// system error and falls through to the generic 500 handler, which
// does not echo the error's message back to the client — only these
// known, safe-to-display validation errors are ever returned verbatim.
const EXPECTED_POSTING_ERRORS = [
  UnbalancedEntryError,
  InsufficientLinesError,
  UnknownAccountError,
  FinancialYearClosedError,
  PeriodLockedError,
  NoFinancialYearError,
  JournalEntryNotFoundError,
  JournalEntryNotPostedError,
  JournalEntryAlreadyReversedError,
];

function isExpectedPostingError(err: unknown): err is Error {
  return EXPECTED_POSTING_ERRORS.some((ErrClass) => err instanceof ErrClass);
}

router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const { status, fromDate, toDate } = req.query;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    params.push(status);
    conditions.push(`je.status = $${params.length}`);
  }
  if (fromDate) {
    params.push(fromDate);
    conditions.push(`je.entry_date >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    conditions.push(`je.entry_date <= $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";

  const { rows } = await query(
    `select je.*, fy.code as financial_year_code
     from journal_entries je
     join financial_years fy on fy.id = je.financial_year_id
     ${where}
     order by je.entry_date desc, je.id desc`,
    params,
  );
  return res.status(200).json(rows);
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: headerRows } = await query(
    `select je.*, fy.code as financial_year_code from journal_entries je
     join financial_years fy on fy.id = je.financial_year_id
     where je.id = $1`,
    [id],
  );
  if (headerRows.length === 0) return res.status(404).json({ error: "Journal entry not found." });

  const { rows: lineRows } = await query(
    `select jel.*, coa.account_code, coa.account_name
     from journal_entry_lines jel
     join chart_of_accounts coa on coa.id = jel.account_id
     where jel.journal_entry_id = $1
     order by jel.line_no`,
    [id],
  );

  return res.status(200).json({ ...headerRows[0], lines: lineRows });
}));

/**
 * Posts a manual journal entry directly. Manual entries have no
 * "draft" holding area in Phase 1 — they validate and post in one
 * step, same as the posting engine's contract requires. (Draft-first
 * workflows for invoices/purchases are a Phase 2 concern, layered on
 * top of this same engine — drafts simply don't call postJournalEntry
 * until the user posts.)
 */
router.post("/", requirePermission("journal-entries.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { entryDate, narration, lines, projectId } = req.body ?? {};

  if (!entryDate || !narration || !Array.isArray(lines)) {
    return res.status(400).json({ error: "entryDate, narration, and lines[] are required." });
  }

  const normalizedLines = lines.map((l: { accountCode: string; debit: number; credit: number; narration?: string; partyType?: "customer" | "vendor"; partyId?: number }) => ({
    accountCode: l.accountCode,
    debit: Number(l.debit) || 0,
    credit: Number(l.credit) || 0,
    narration: l.narration,
    partyType: l.partyType,
    partyId: l.partyId,
  }));

  try {
    validateBalance(normalizedLines);
  } catch (err) {
    return res.status(422).json({ error: (err as Error).message });
  }

  try {
    const result = await withTransaction((client) =>
      postJournalEntry(client, {
        entryDate,
        narration,
        sourceType: "manual",
        lines: normalizedLines,
        userId: req.user?.userId ?? null,
        ipAddress: req.ip,
        // Project Management integration: manual JEs have no document
        // table of their own (see posting-engine.ts's JournalEntryInput
        // comment), so the tag is accepted directly here and passed
        // straight through — undefined/omitted resolves to NULL exactly
        // as it did before this field existed.
        projectId: projectId != null ? Number(projectId) : null,
      }),
    );
    return res.status(201).json(result);
  } catch (err) {
    if (isExpectedPostingError(err)) {
      return res.status(422).json({ error: err.message });
    }
    throw err; // unexpected — asyncHandler forwards to the generic 500 handler, no message leaked
  }
}));

router.post("/:id/reverse", requirePermission("journal-entries.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { reason } = req.body ?? {};
  if (!reason) return res.status(400).json({ error: "reason is required." });

  try {
    const result = await withTransaction((client) =>
      reverseJournalEntry(client, id, req.user?.userId ?? null, reason),
    );
    return res.status(200).json(result);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (message.includes("not found")) {
      return res.status(404).json({ error: message });
    }
    if (
      message.includes("Only posted entries can be reversed") ||
      message.includes("already been reversed") ||
      isExpectedPostingError(err)
    ) {
      return res.status(422).json({ error: message });
    }
    throw err;
  }
}));

export default router;
