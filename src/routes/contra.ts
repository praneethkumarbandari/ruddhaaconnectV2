import { Router, type Request, type Response } from "express";
import { withTransaction } from "../db/pool.ts";
import { postContra } from "../lib/contra.ts";
import { reverseJournalEntry } from "../lib/posting-engine.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("contra.view"));

router.post("/", requirePermission("contra.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { entryDate, fromAccountCode, toAccountCode, amount, narration, projectId } = req.body ?? {};
  if (!entryDate || !fromAccountCode || !toAccountCode || !amount) {
    return res.status(400).json({ error: "entryDate, fromAccountCode, toAccountCode, and amount are required." });
  }
  try {
    const result = await withTransaction((client) =>
      postContra(client, {
        entryDate,
        fromAccountCode,
        toAccountCode,
        amount: Number(amount),
        narration,
        userId: req.user?.userId ?? null,
        projectId: projectId != null ? Number(projectId) : null,
      }),
    );
    return res.status(201).json(result);
  } catch (err) {
    handleDomainError(err, res);
  }
}));

/**
 * FIX (flagged, unaddressed, across two reviews): contra was the one
 * voucher type with no way to cancel a mistaken entry. postContra()
 * calls postJournalEntry() directly — there is no separate "contra"
 * document table the way invoices/notes have one — so "cancel" here
 * is exactly reversing that underlying journal entry, the same real
 * mechanism /api/journal-entries/:id/reverse already uses. Mirrors
 * that route's error-handling exactly: reverseJournalEntry() throws
 * plain Error objects with message text, not typed classes registered
 * in the centralized handleDomainError mapper, so this matches the
 * same manual message-matching journal-entries.ts already does for
 * this same function, rather than inventing a second convention.
 */
router.post("/:id/reverse", requirePermission("contra.manage"), asyncHandler(async (req: Request, res: Response) => {
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
      message.includes("already been reversed")
    ) {
      return res.status(422).json({ error: message });
    }
    throw err;
  }
}));

export default router;
