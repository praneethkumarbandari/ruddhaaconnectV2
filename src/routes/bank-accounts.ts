import { Router, type Request, type Response } from "express";
import { query, withTransaction } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import {
  listBankAccounts, getBankAccount, createBankAccount, updateBankAccount,
  listBankTransactions, mapBankTransaction, getOpenInvoicesForParty,
  postGenericBankTransaction, postCustomerVendorTransaction,
  listTransferCandidates, postTransferBankTransaction,
  backfillOpeningBalances,
  EXPECTED_BANK_POSTING_ERRORS,
  BankAccountNotFoundError, BankTransactionNotFoundError,
} from "../lib/bank-accounts.ts";

const router = Router();
router.use(requirePermission("bank-accounts.view"));

/**
 * ONE-TIME BACKFILL — for bank accounts created before opening-
 * balance postings existed. Safe to call more than once (already-
 * posted accounts are skipped, never double-posted). See
 * backfillOpeningBalances()'s own comment in lib/bank-accounts.ts.
 */
router.post("/backfill-opening-balances", requirePermission("bank-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const result = await backfillOpeningBalances(req.user?.userId ?? null);
  return res.status(200).json(result);
}));

function isExpectedBankError(err: unknown): err is Error {
  return EXPECTED_BANK_POSTING_ERRORS.some((ErrClass) => err instanceof ErrClass);
}

function mapBankRouteError(err: unknown, res: Response): boolean {
  if (err instanceof BankAccountNotFoundError || err instanceof BankTransactionNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  if (isExpectedBankError(err)) {
    res.status(422).json({ error: (err as Error).message });
    return true;
  }
  return false;
}

// ------------------------------------------------------------
// BANK ACCOUNTS
// ------------------------------------------------------------

router.get("/accounts", asyncHandler(async (_req: Request, res: Response) => {
  const rows = await listBankAccounts();
  return res.status(200).json(rows);
}));

// FIX: the Bank & Cash list page needed a top-level "total net position"
// summary card across every account. Computing that client-side would
// mean one extra request per account just to sum its transactions —
// wasteful, and slower the more accounts a business has. One query
// instead: sum each account's own opening balance plus its own
// credits-minus-debits, aggregated across all accounts in a single
// round trip.
router.get("/net-position", asyncHandler(async (_req: Request, res: Response) => {
  // FIX (same bug as dashboard's Cash in Hand, same fix): this used to
  // sum raw bank_transactions rows plus bank_accounts.opening_balance
  // directly — counting Unmapped/Ignored/Duplicate/not-yet-Posted
  // imported rows the moment they're imported, and double-counting
  // any opening balance that's already been posted as a real journal
  // entry. Journal is the single source of truth: this now sums ONLY
  // journal_entry_lines belonging to a POSTED journal entry, for
  // every account actually linked to a bank account.
  const { rows } = await query(
    `select
       coalesce(sum(jel.debit - jel.credit), 0) as total_net,
       coalesce(sum(case when jel.debit > 0 then jel.debit else 0 end), 0) as total_debits,
       coalesce(sum(case when jel.credit > 0 then jel.credit else 0 end), 0) as total_credits
     from journal_entry_lines jel
     join journal_entries je on je.id = jel.journal_entry_id
     join bank_accounts ba on ba.coa_id = jel.account_id
     where je.status = 'posted'
       and ba.is_active is distinct from false`,
  );
  // total_opening is shown purely as reference info (what was entered
  // as each account's opening balance) — NOT added into total_net,
  // since a posted opening balance is already inside journal_entry_lines
  // and would double-count; an un-posted one correctly isn't counted
  // in the real ledger figure at all until it's actually posted.
  const { rows: openingRows } = await query(
    `select coalesce(sum(opening_balance), 0) as total_opening from bank_accounts where is_active is distinct from false`,
  );
  return res.status(200).json({ ...rows[0], total_opening: openingRows[0].total_opening });
}));

// FIX: topbar notification badge needs a real count of unmapped bank
// transactions, not a fake number — one query, not a full-table fetch.
router.get("/unmapped-count", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select count(*)::int as count from bank_transactions where mapping_status = 'Unmapped'`);
  return res.status(200).json({ count: rows[0].count });
}));

// FIX: only a count existed — the Dashboard's "Unmapped Transactions"
// panel needs the actual short list to work as a real work queue
// (per the approved dashboard layout), not just a number.
router.get("/unmapped-recent", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(
    `select bt.id, bt.transaction_date, bt.description, bt.debit, bt.credit, ba.account_name
     from bank_transactions bt
     join bank_accounts ba on ba.id = bt.bank_account_id
     where bt.mapping_status = 'Unmapped'
     order by bt.transaction_date desc, bt.id desc
     limit 5`,
  );
  return res.status(200).json(rows);
}));

router.get("/accounts/:id", asyncHandler(async (req: Request, res: Response) => {
  try {
    const account = await getBankAccount(Number(req.params.id));
    return res.status(200).json(account);
  } catch (err) {
    if (mapBankRouteError(err, res)) return;
    throw err;
  }
}));

router.post("/accounts", requirePermission("bank-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { accountType, accountName, openingBalance, ledgerAccountCode, bankName, accountNumber, ifsc } = req.body ?? {};
  if (!accountType || !accountName || openingBalance == null || !ledgerAccountCode) {
    return res.status(400).json({ error: "accountType, accountName, openingBalance, and ledgerAccountCode are required." });
  }
  try {
    const account = await createBankAccount({
      accountType, accountName, openingBalance: Number(openingBalance), ledgerAccountCode,
      bankName, accountNumber, ifsc, userId: req.user?.userId ?? null,
    });
    return res.status(201).json(account);
  } catch (err) {
    if (mapBankRouteError(err, res)) return;
    throw err;
  }
}));

router.patch("/accounts/:id", requirePermission("bank-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { accountType, accountName, openingBalance, ledgerAccountCode, bankName, accountNumber, ifsc } = req.body ?? {};
  if (!accountType || !accountName || openingBalance == null || !ledgerAccountCode) {
    return res.status(400).json({ error: "accountType, accountName, openingBalance, and ledgerAccountCode are required." });
  }
  try {
    const account = await updateBankAccount(Number(req.params.id), {
      accountType, accountName, openingBalance: Number(openingBalance), ledgerAccountCode,
      bankName, accountNumber, ifsc, userId: req.user?.userId ?? null,
    });
    return res.status(200).json(account);
  } catch (err) {
    if (mapBankRouteError(err, res)) return;
    throw err;
  }
}));

// ------------------------------------------------------------
// BANK TRANSACTIONS
// ------------------------------------------------------------

router.get("/accounts/:accountId/transactions", asyncHandler(async (req: Request, res: Response) => {
  const rows = await listBankTransactions(Number(req.params.accountId));
  return res.status(200).json(rows);
}));

router.post("/transactions/:id/map", requirePermission("bank-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { mappedTo } = req.body ?? {};
  if (!mappedTo) return res.status(400).json({ error: "mappedTo is required." });
  try {
    const txn = await mapBankTransaction(Number(req.params.id), { mappedTo, userId: req.user?.userId ?? null });
    return res.status(200).json(txn);
  } catch (err) {
    if (mapBankRouteError(err, res)) return;
    throw err;
  }
}));

/**
 * Open invoices for the party a transaction is mapped to — powers the
 * allocation modal exactly as before, now reading real outstanding
 * balances from receipt_allocations/payment_allocations instead of
 * the frontend recomputing it client-side.
 */
router.get("/parties/:partyType/:partyId/open-invoices", asyncHandler(async (req: Request, res: Response) => {
  const { partyType, partyId } = req.params;
  if (partyType !== "customer" && partyType !== "vendor") {
    return res.status(400).json({ error: "partyType must be 'customer' or 'vendor'." });
  }
  const rows = await getOpenInvoicesForParty(partyType === "customer", Number(partyId));
  return res.status(200).json(rows);
}));

/**
 * Post a bank transaction mapped to Expense/Income/Transfer/Loan/
 * Capital/Adjustment — a bare journal entry via postJournalEntry().
 */
router.post("/transactions/:id/post", requirePermission("bank-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await postGenericBankTransaction(Number(req.params.id), req.user?.userId ?? null);
    return res.status(200).json(result);
  } catch (err) {
    if (mapBankRouteError(err, res)) return;
    throw err;
  }
}));

/**
 * Candidate counterpart transactions for linking a Transfer — the
 * other real-world leg of the same movement, on a different bank
 * account's own import, unposted, opposite direction, same amount.
 * See listTransferCandidates() in lib/bank-accounts.ts.
 */
router.get("/transactions/:id/transfer-candidates", asyncHandler(async (req: Request, res: Response) => {
  try {
    const rows = await listTransferCandidates(Number(req.params.id));
    return res.status(200).json(rows);
  } catch (err) {
    if (mapBankRouteError(err, res)) return;
    throw err;
  }
}));

/**
 * Posts a Transfer as ONE contra entry covering both legs at once —
 * replaces posting each bank statement row independently, which used
 * to create two unrelated journal entries for one transfer. See
 * postTransferBankTransaction()'s own comment in lib/bank-accounts.ts.
 */
router.post("/transactions/:id/post-transfer", requirePermission("bank-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { counterpartTransactionId } = req.body ?? {};
  if (!counterpartTransactionId) return res.status(400).json({ error: "counterpartTransactionId is required." });
  try {
    const result = await postTransferBankTransaction(
      Number(req.params.id),
      Number(counterpartTransactionId),
      req.user?.userId ?? null,
    );
    return res.status(200).json(result);
  } catch (err) {
    if (mapBankRouteError(err, res)) return;
    throw err;
  }
}));

/**
 * Post a bank transaction mapped to Customer/Vendor — goes through
 * the real receipts/payments engine with allocation, exactly as the
 * frontend's allocation modal already offered.
 */
router.post("/transactions/:id/post-allocated", requirePermission("bank-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { allocations } = req.body ?? {};
  if (!Array.isArray(allocations)) return res.status(400).json({ error: "allocations[] is required (can be empty for a full advance)." });
  try {
    const result = await postCustomerVendorTransaction(
      Number(req.params.id),
      allocations.map((a: { invoiceId: number; amount: number }) => ({ invoiceId: Number(a.invoiceId), amount: Number(a.amount) })),
      req.user?.userId ?? null,
    );
    return res.status(200).json(result);
  } catch (err) {
    if (mapBankRouteError(err, res)) return;
    throw err;
  }
}));

/**
 * Batch import raw transactions from CSV/XLSX. Inserts rows as
 * 'Unmapped' — same status they'd get from the old direct Supabase
 * insert, preserving the existing mapping workflow exactly.
 */
router.post("/accounts/:accountId/import-transactions", requirePermission("bank-accounts.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { transactions } = req.body ?? {};
  const accountId = Number(req.params.accountId);
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: "transactions[] is required and must not be empty." });
  }
  const { rows: acct } = await query(`select id from bank_accounts where id = $1`, [accountId]);
  if (acct.length === 0) return res.status(404).json({ error: `Bank account ${accountId} not found.` });

  // FIX: this previously used a hand-rolled pool.query("begin") /
  // pool.query("commit") / pool.query("rollback") sequence, with each
  // call independently checked out from the pool via a dynamic
  // import — not the shared withTransaction() helper. Under
  // Supabase's Transaction-mode pooler (see pool.ts's own
  // documentation), separate pool.query() calls are not guaranteed to
  // land on the same physical connection, meaning this provided no
  // real atomicity guarantee at all: a failure partway through the
  // loop could leave some rows committed and others not, with the
  // "rollback" call potentially running on a different connection
  // than the one that actually inserted the earlier rows. Also
  // discovered while migrating this route onto the tenant-scoped
  // query() helper — a hand-rolled begin/commit here would have
  // tried to open a second, conflicting transaction on top of the
  // one the request-level tenant context already opened. Using
  // withTransaction() fixes both: real atomicity via the existing,
  // already-proven SAVEPOINT-based nesting, and correct tenant
  // scoping, in one change.
  await withTransaction(async (client) => {
    for (const t of transactions) {
      await client.query(
        `insert into bank_transactions (bank_account_id, transaction_date, description, reference_no, debit, credit, mapping_status)
         values ($1, $2, $3, $4, $5, $6, 'Unmapped')`,
        [accountId, t.transaction_date, t.description || null, t.reference_no || null, Number(t.debit) || 0, Number(t.credit) || 0],
      );
    }
  });
  return res.status(201).json({ imported: transactions.length });
}));

export default router;
