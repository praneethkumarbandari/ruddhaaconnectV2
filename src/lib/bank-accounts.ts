import type { PgClient } from "../db/pool.ts";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";
import { postJournalEntry, validateBalance, UnbalancedEntryError, InsufficientLinesError, UnknownAccountError } from "./posting-engine.ts";
import { postContra, SameAccountError, InvalidContraAccountError } from "./contra.ts";
import { createDraftReceipt, postReceipt } from "./receipts.ts";
import { createDraftPayment, postPayment } from "./payments.ts";
import { FinancialYearClosedError, PeriodLockedError, NoFinancialYearError } from "./fy.ts";

/**
 * Bank & Cash service layer.
 *
 * Architecture migration note: content/bank.html previously wrote
 * journal_entries/journal_entry_lines rows directly, using a
 * DIFFERENT column shape (journal_no) than the real, frozen
 * accounting schema (je_no, schema.sql) and a separate numbering
 * table (numbering_sequences vs the real nextDocumentNumber()).
 * Those legacy writes are not carried forward. Every posting path
 * below goes through the same posting engine every other accounting
 * module uses:
 *   - Customer-mapped transactions -> createDraftReceipt + postReceipt
 *     (src/lib/receipts.ts) — the exact same engine Receipts uses.
 *   - Vendor-mapped transactions   -> createDraftPayment + postPayment
 *     (src/lib/payments.ts) — the exact same engine Payments uses.
 *   - Everything else (Expense/Income/Transfer/Loan/Capital/Adjustment)
 *     -> postJournalEntry directly (src/lib/posting-engine.ts), tagged
 *     sourceType: 'bank_mapping' — the same engine manual Journal
 *     Entries and Contra use, since these mappings have no document
 *     table of their own, exactly like those two already didn't.
 * journal_entries.je_no, financial year checks, and account-code
 * resolution are therefore handled once, correctly, by the engine —
 * not reimplemented here.
 */

export class BankAccountNotFoundError extends Error {
  constructor(id: number) {
    super(`Bank account ${id} not found.`);
    this.name = "BankAccountNotFoundError";
  }
}
export class BankTransactionNotFoundError extends Error {
  constructor(id: number) {
    super(`Bank transaction ${id} not found.`);
    this.name = "BankTransactionNotFoundError";
  }
}
export class LedgerAccountNotMappedError extends Error {
  constructor() {
    super("This bank account has no ledger account mapped. Set its Ledger Account first.");
    this.name = "LedgerAccountNotMappedError";
  }
}
export class UnknownMappingTypeError extends Error {
  constructor(type: string) {
    super(`Unrecognized mapping type '${type}'.`);
    this.name = "UnknownMappingTypeError";
  }
}
export class TransactionAlreadyPostedError extends Error {
  constructor(id: number) {
    super(`Bank transaction ${id} is already posted.`);
    this.name = "TransactionAlreadyPostedError";
  }
}
export class TransactionNotMappedError extends Error {
  constructor(id: number) {
    super(`Bank transaction ${id} must be mapped before it can be posted.`);
    this.name = "TransactionNotMappedError";
  }
}
export class AccountMappingNotConfiguredError extends Error {
  constructor(which: "debtors" | "creditors") {
    super(
      `${which === "debtors" ? "Sundry Debtors" : "Sundry Creditors"} account is not configured. ` +
      `Set it in Settings \u2192 Account Mapping first.`,
    );
    this.name = "AccountMappingNotConfiguredError";
  }
}

// ------------------------------------------------------------
// BANK ACCOUNTS
// ------------------------------------------------------------

export async function listBankAccounts() {
  const { rows } = await query(
    `select ba.*, coa.account_code, coa.account_name as ledger_account_name
     from bank_accounts ba
     join chart_of_accounts coa on coa.id = ba.coa_id
     order by ba.account_name`,
  );
  return rows;
}

export async function getBankAccount(id: number) {
  const { rows } = await query(
    `select ba.*, coa.account_code, coa.account_name as ledger_account_name
     from bank_accounts ba
     join chart_of_accounts coa on coa.id = ba.coa_id
     where ba.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new BankAccountNotFoundError(id);
  return rows[0];
}

export type BankAccountInput = {
  accountType: string;
  accountName: string;
  openingBalance: number;
  ledgerAccountCode: string;
  bankName?: string | null;
  accountNumber?: string | null;
  ifsc?: string | null;
  userId: number | null;
};

async function resolveCoaId(client: PgClient, ledgerAccountCode: string): Promise<number> {
  const { rows } = await client.query(
    `select id from chart_of_accounts where account_code = $1 and is_active = true`,
    [ledgerAccountCode],
  );
  if (rows.length === 0) throw new UnknownAccountError(ledgerAccountCode);
  return rows[0].id;
}

export class DuplicateBankLedgerError extends Error {
  constructor(ledgerAccountCode: string) {
    super(`Ledger account ${ledgerAccountCode} is already linked to another bank account. Each ledger can back only one bank account.`);
    this.name = "DuplicateBankLedgerError";
  }
}
export class DuplicateBankAccountNumberError extends Error {
  constructor() {
    super("A bank account with this bank name and account number already exists.");
    this.name = "DuplicateBankAccountNumberError";
  }
}

export async function createBankAccount(input: BankAccountInput) {
  return withTransaction(async (client) => {
    const coaId = await resolveCoaId(client, input.ledgerAccountCode);
    const isBankType = ["Savings Account", "Current Account", "OD", "Credit Card"].includes(input.accountType);
    let rows;
    try {
      ({ rows } = await client.query(
        `insert into bank_accounts (account_type, account_name, opening_balance, coa_id, bank_name, account_number, ifsc, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         returning *`,
        [
          input.accountType, input.accountName, input.openingBalance, coaId,
          isBankType ? (input.bankName ?? null) : null,
          isBankType ? (input.accountNumber ?? null) : null,
          isBankType ? (input.ifsc ?? null) : null,
          input.userId,
        ],
      ));
    } catch (err) {
      // FIX (duplicate-masters prevention): these two unique
      // constraints (schema-prevent-duplicate-masters.sql) stop a
      // ledger being double-linked to two bank accounts, and the same
      // real bank account being entered twice — surfaced here as
      // clean, actionable messages instead of a raw Postgres 23505.
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505" && pgErr.constraint === "bank_accounts_coa_id_unique") {
        throw new DuplicateBankLedgerError(input.ledgerAccountCode);
      }
      if (pgErr.code === "23505" && pgErr.constraint === "idx_bank_accounts_no_duplicate_account_number") {
        throw new DuplicateBankAccountNumberError();
      }
      throw err;
    }
    const account = rows[0];
    await writeAudit(client, {
      userId: input.userId, action: "create", module: "bank_accounts",
      recordId: account.id, newValue: { account_name: input.accountName, account_type: input.accountType },
    });

    // FIX: previously this number only ever lived on bank_accounts.
    // opening_balance — never posted, so it never appeared in
    // Balance Sheet/Trial Balance/P&L (all strictly derived from
    // posted journal_entry_lines). Now posts a real, balanced entry:
    // debit this account's own ledger for the opening amount, credit
    // Capital (account code 3000, the standard seeded equity account
    // every company gets) for the same amount — the conventional
    // double-entry treatment for a new account's opening balance.
    if (input.openingBalance && Number(input.openingBalance) !== 0) {
      const amount = Number(input.openingBalance);
      const today = new Date().toISOString().slice(0, 10);
      await postJournalEntry(client, {
        entryDate: today,
        narration: `Opening balance — ${input.accountName}`,
        sourceType: "bank_account_opening",
        sourceId: account.id,
        userId: input.userId ?? null,
        lines: [
          { accountCode: input.ledgerAccountCode, debit: amount, credit: 0 },
          { accountCode: "3000", debit: 0, credit: amount },
        ],
      });
    }

    return account;
  });
}

export async function updateBankAccount(id: number, input: BankAccountInput) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from bank_accounts where id = $1`, [id]);
    if (existing.length === 0) throw new BankAccountNotFoundError(id);

    const coaId = await resolveCoaId(client, input.ledgerAccountCode);
    const isBankType = ["Savings Account", "Current Account", "OD", "Credit Card"].includes(input.accountType);
    let rows;
    try {
      ({ rows } = await client.query(
        `update bank_accounts set
           account_type = $2, account_name = $3, opening_balance = $4, coa_id = $5,
           bank_name = $6, account_number = $7, ifsc = $8, updated_by = $9, updated_at = now()
         where id = $1
         returning *`,
        [
          id, input.accountType, input.accountName, input.openingBalance, coaId,
          isBankType ? (input.bankName ?? null) : null,
          isBankType ? (input.accountNumber ?? null) : null,
          isBankType ? (input.ifsc ?? null) : null,
          input.userId,
        ],
      ));
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505" && pgErr.constraint === "bank_accounts_coa_id_unique") {
        throw new DuplicateBankLedgerError(input.ledgerAccountCode);
      }
      if (pgErr.code === "23505" && pgErr.constraint === "idx_bank_accounts_no_duplicate_account_number") {
        throw new DuplicateBankAccountNumberError();
      }
      throw err;
    }
    await writeAudit(client, {
      userId: input.userId, action: "update", module: "bank_accounts",
      recordId: id, oldValue: existing[0], newValue: rows[0],
    });
    return rows[0];
  });
}

// ------------------------------------------------------------
// BANK TRANSACTIONS
// ------------------------------------------------------------

export async function listBankTransactions(bankAccountId: number) {
  const { rows } = await query(
    `select * from bank_transactions where bank_account_id = $1 order by transaction_date desc, id desc`,
    [bankAccountId],
  );
  return rows;
}

export type MapTransactionInput = {
  mappedTo: string; // 'Type:refId:label' — exact same encoding the frontend already parses/builds
  userId: number | null;
};

export async function mapBankTransaction(id: number, input: MapTransactionInput) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from bank_transactions where id = $1`, [id]);
    if (existing.length === 0) throw new BankTransactionNotFoundError(id);
    if (existing[0].mapping_status === "Posted") throw new TransactionAlreadyPostedError(id);

    const { rows } = await client.query(
      `update bank_transactions set mapping_status = 'Mapped', mapped_to = $2, updated_at = now() where id = $1 returning *`,
      [id, input.mappedTo],
    );
    await writeAudit(client, {
      userId: input.userId, action: "update", module: "bank_transactions",
      recordId: id, oldValue: { mapping_status: existing[0].mapping_status }, newValue: { mapping_status: "Mapped", mapped_to: input.mappedTo },
    });
    return rows[0];
  });
}

function parseMappedTo(mappedTo: string | null): { type: string; refId: string; label: string } {
  const parts = (mappedTo || "").split(":");
  return { type: parts[0] || "", refId: parts[1] || "", label: parts.slice(2).join(":").trim() };
}

/**
 * Open invoices for a customer/vendor, with outstanding computed
 * against the REAL receipts/payments allocation tables — same
 * "outstanding = total - sum(allocations)" rule the rest of the
 * accounting module already enforces, not a re-derivation.
 *
 * FIX (performance): this used to run one query per invoice to sum
 * that invoice's own allocations (a real N+1 — one round trip per
 * open invoice). Now a single query aggregates every invoice's
 * allocations at once via a LEFT JOIN + GROUP BY, so this is always
 * exactly one query regardless of how many invoices the party has.
 */
export async function getOpenInvoicesForParty(isCustomer: boolean, partyId: number) {
  const table = isCustomer ? "sales_invoices" : "purchase_invoices";
  const allocTable = isCustomer ? "receipt_allocations" : "payment_allocations";
  const invoiceIdCol = isCustomer ? "sales_invoice_id" : "purchase_invoice_id";
  const partyCol = isCustomer ? "customer_id" : "vendor_id";

  const { rows } = await query(
    `select inv.*, coalesce(alloc.allocated, 0) as allocated
     from ${table} inv
     left join (
       select ${invoiceIdCol} as invoice_id, sum(allocated_amount) as allocated
       from ${allocTable}
       group by ${invoiceIdCol}
     ) alloc on alloc.invoice_id = inv.id
     where inv.${partyCol} = $1 and inv.status = 'posted'`,
    [partyId],
  );

  return rows
    .map((inv) => ({ ...inv, outstanding: (Number(inv.total_amount) || 0) - (Number(inv.allocated) || 0) }))
    .filter((inv) => inv.outstanding > 0.01);
}

/**
 * Posts a bank transaction mapped to Expense/Income/Transfer/Loan/
 * Capital/Adjustment — i.e. anything that is NOT Customer/Vendor
 * (those go through postCustomerVendorTransaction below instead,
 * since they need receipt/payment allocation, not a bare journal
 * entry). Two ledger lines: the bank account's own mapped ledger
 * account, and the counter-account from the mapping — same shape
 * the frontend's postGenericJournal always produced, just posted
 * through postJournalEntry() instead of hand-written inserts.
 */
export async function postGenericBankTransaction(transactionId: number, userId: number | null) {
  return withTransaction(async (client) => {
    const { rows: txnRows } = await client.query(`select * from bank_transactions where id = $1 for update`, [transactionId]);
    if (txnRows.length === 0) throw new BankTransactionNotFoundError(transactionId);
    const txn = txnRows[0];
    if (txn.mapping_status === "Posted") throw new TransactionAlreadyPostedError(transactionId);
    if (txn.mapping_status !== "Mapped" || !txn.mapped_to) throw new TransactionNotMappedError(transactionId);

    const parsed = parseMappedTo(txn.mapped_to);
    if (parsed.type === "Customer" || parsed.type === "Vendor") {
      throw new UnknownMappingTypeError(parsed.type); // caller routed wrong — use postCustomerVendorTransaction
    }
    if (parsed.type === "Transfer") {
      // FIX (real bug, found in production): a bank-to-bank transfer
      // arrives as TWO independent statement rows — one on the source
      // bank's import, one on the destination bank's import. Posting
      // each one separately through this generic path (as it used to)
      // created TWO unrelated journal entries for what is one single
      // economic movement of money, each one hitting a generic COA
      // "counter account" instead of the actual other bank ledger —
      // meaning a transfer never showed up as a clean contra between
      // the two real bank accounts at all, and, since the two legs
      // were posted independently, nothing stopped one leg getting
      // mapped and posted without its counterpart ever being touched.
      // Transfers must be posted as ONE contra entry, both legs at
      // once — see postTransferBankTransaction() below.
      throw new UnknownMappingTypeError(parsed.type); // caller routed wrong — use postTransferBankTransaction
    }

    const { rows: acctRows } = await client.query(`select coa_id from bank_accounts where id = $1`, [txn.bank_account_id]);
    if (acctRows.length === 0) throw new BankAccountNotFoundError(txn.bank_account_id);
    const { rows: bankCoaRows } = await client.query(`select account_code, account_name from chart_of_accounts where id = $1`, [acctRows[0].coa_id]);
    if (bankCoaRows.length === 0) throw new LedgerAccountNotMappedError();
    const bankAcc = bankCoaRows[0];

    const { rows: counterRows } = await client.query(
      `select account_code, account_name from chart_of_accounts where account_code = $1 and is_active = true`,
      [parsed.refId],
    );
    if (counterRows.length === 0) throw new UnknownAccountError(parsed.refId);
    const counterAcc = counterRows[0];

    const amt = Number(txn.debit) || Number(txn.credit) || 0;
    const isCredit = Number(txn.credit) > 0;
    const lines = isCredit
      ? [
          { accountCode: bankAcc.account_code, debit: amt, credit: 0 },
          { accountCode: counterAcc.account_code, debit: 0, credit: amt },
        ]
      : [
          { accountCode: counterAcc.account_code, debit: amt, credit: 0 },
          { accountCode: bankAcc.account_code, debit: 0, credit: amt },
        ];

    const { id: jeId, jeNo } = await postJournalEntry(client, {
      entryDate: txn.transaction_date,
      narration: `Bank mapping — ${txn.description || ""}`,
      sourceType: "bank_mapping",
      sourceId: txn.id,
      lines,
      userId,
    });

    await client.query(
      `update bank_transactions set mapping_status = 'Posted', posted_je_id = $2, updated_at = now() where id = $1`,
      [transactionId, jeId],
    );
    await writeAudit(client, {
      userId, action: "post", module: "bank_transactions",
      recordId: transactionId, oldValue: { mapping_status: "Mapped" }, newValue: { mapping_status: "Posted", je_no: jeNo },
    });

    return { jeNo };
  });
}

export type AllocationInput = { invoiceId: number; amount: number };

export class TransferMismatchError extends Error {
  constructor(detail: string) {
    super(`These two transactions can't be linked as one transfer: ${detail}`);
    this.name = "TransferMismatchError";
  }
}
export class TransferSameAccountError extends Error {
  constructor() {
    super("A transfer must be between two different bank accounts, not the same one.");
    this.name = "TransferSameAccountError";
  }
}

/**
 * Candidate counterpart transactions for linking a Transfer — the
 * other leg of the same real-world movement, sitting unposted on a
 * DIFFERENT bank account's own imported statement, with the opposite
 * direction (this one's an inflow, the candidate's an outflow, or
 * vice versa) and — as the strongest signal — the same amount.
 * Matching on amount+opposite-direction rather than date, since bank
 * value-dates between two accounts at two different banks routinely
 * differ by a day or more for the same transfer.
 */
export async function listTransferCandidates(transactionId: number) {
  const { rows: txnRows } = await query(`select * from bank_transactions where id = $1`, [transactionId]);
  if (txnRows.length === 0) throw new BankTransactionNotFoundError(transactionId);
  const txn = txnRows[0];
  const amt = Number(txn.debit) || Number(txn.credit) || 0;
  const isCredit = Number(txn.credit) > 0;

  const { rows } = await query(
    `select bt.*, ba.account_name as bank_account_name, ba.bank_name
     from bank_transactions bt
     join bank_accounts ba on ba.id = bt.bank_account_id
     where bt.bank_account_id != $1
       and bt.mapping_status != 'Posted'
       and ${isCredit ? "bt.debit" : "bt.credit"} = $2
     order by bt.transaction_date desc
     limit 20`,
    [txn.bank_account_id, amt],
  );
  return rows;
}

/**
 * Posts a bank-to-bank Transfer as ONE contra journal entry covering
 * BOTH legs at once — Dr the destination bank / Cr the source bank —
 * and marks BOTH bank_transactions rows Posted against that same
 * journal entry. This replaces the old behavior (each statement row
 * posted independently through postGenericBankTransaction, hitting a
 * generic COA "counter account") which produced two unrelated journal
 * entries for one economic transfer — see the FIX comment on the
 * Transfer rejection in postGenericBankTransaction above.
 */
export async function postTransferBankTransaction(
  transactionId: number,
  counterpartTransactionId: number,
  userId: number | null,
) {
  return withTransaction(async (client) => {
    if (transactionId === counterpartTransactionId) {
      throw new TransferMismatchError("a transaction cannot be its own counterpart.");
    }

    const { rows: bothRows } = await client.query(
      `select * from bank_transactions where id in ($1, $2) for update`,
      [transactionId, counterpartTransactionId],
    );
    const txn = bothRows.find((r) => r.id === transactionId);
    const counterpart = bothRows.find((r) => r.id === counterpartTransactionId);
    if (!txn) throw new BankTransactionNotFoundError(transactionId);
    if (!counterpart) throw new BankTransactionNotFoundError(counterpartTransactionId);

    if (txn.mapping_status === "Posted") throw new TransactionAlreadyPostedError(transactionId);
    if (counterpart.mapping_status === "Posted") throw new TransactionAlreadyPostedError(counterpartTransactionId);
    if (txn.bank_account_id === counterpart.bank_account_id) throw new TransferSameAccountError();

    const txnAmt = Number(txn.debit) || Number(txn.credit) || 0;
    const cpAmt = Number(counterpart.debit) || Number(counterpart.credit) || 0;
    if (Math.round(txnAmt * 100) !== Math.round(cpAmt * 100)) {
      throw new TransferMismatchError(
        `amounts don't match (${txnAmt} vs ${cpAmt}). If the bank deducted a transfer fee, post that fee as its own separate Expense-mapped transaction, then link the remaining equal amounts as the transfer.`,
      );
    }
    const txnIsCredit = Number(txn.credit) > 0;
    const cpIsCredit = Number(counterpart.credit) > 0;
    if (txnIsCredit === cpIsCredit) {
      throw new TransferMismatchError("both legs move money the same direction — a transfer needs one inflow and one outflow.");
    }

    // The credit-side leg (inflow) is the DESTINATION account; the
    // debit-side leg (outflow) is the SOURCE account.
    const destTxn = txnIsCredit ? txn : counterpart;
    const srcTxn = txnIsCredit ? counterpart : txn;

    const { rows: destAcctRows } = await client.query(
      `select coa.account_code from bank_accounts ba join chart_of_accounts coa on coa.id = ba.coa_id where ba.id = $1`,
      [destTxn.bank_account_id],
    );
    const { rows: srcAcctRows } = await client.query(
      `select coa.account_code from bank_accounts ba join chart_of_accounts coa on coa.id = ba.coa_id where ba.id = $1`,
      [srcTxn.bank_account_id],
    );
    if (destAcctRows.length === 0 || srcAcctRows.length === 0) throw new LedgerAccountNotMappedError();

    // Reuses postContra() directly — this genuinely IS a contra entry
    // (asset account to asset account, no income/expense), so it goes
    // through the exact same single-transaction posting path Contra
    // already uses, rather than a second hand-assembled version of
    // the same two lines.
    const { id: jeId, jeNo } = await postContra(client, {
      entryDate: destTxn.transaction_date,
      fromAccountCode: srcAcctRows[0].account_code,
      toAccountCode: destAcctRows[0].account_code,
      amount: txnAmt,
      narration: `Bank transfer — ${txn.description || counterpart.description || ""}`,
      userId,
    });

    await client.query(
      `update bank_transactions set mapping_status = 'Posted', posted_je_id = $2, updated_at = now() where id in ($1, $3)`,
      [transactionId, jeId, counterpartTransactionId],
    );
    await writeAudit(client, {
      userId, action: "post", module: "bank_transactions",
      recordId: transactionId, oldValue: { mapping_status: "Mapped" },
      newValue: { mapping_status: "Posted", je_no: jeNo, linkedTransactionId: counterpartTransactionId },
    });
    await writeAudit(client, {
      userId, action: "post", module: "bank_transactions",
      recordId: counterpartTransactionId, oldValue: { mapping_status: "Mapped" },
      newValue: { mapping_status: "Posted", je_no: jeNo, linkedTransactionId: transactionId },
    });

    return { jeNo };
  });
}

/**
 * Posts a bank transaction mapped to Customer or Vendor: creates and
 * immediately posts a real draft receipt/payment (through
 * receipts.ts/payments.ts — the exact same engine the standalone
 * Receipts/Payments pages use), with the same allocation semantics
 * the frontend's allocation modal already offered (allocate against
 * open invoices; any unallocated remainder becomes an advance).
 */
export async function postCustomerVendorTransaction(
  transactionId: number,
  allocations: AllocationInput[],
  userId: number | null,
) {
  return withTransaction(async (client) => {
    const { rows: txnRows } = await client.query(`select * from bank_transactions where id = $1 for update`, [transactionId]);
    if (txnRows.length === 0) throw new BankTransactionNotFoundError(transactionId);
    const txn = txnRows[0];
    if (txn.mapping_status === "Posted") throw new TransactionAlreadyPostedError(transactionId);
    if (txn.mapping_status !== "Mapped" || !txn.mapped_to) throw new TransactionNotMappedError(transactionId);

    const parsed = parseMappedTo(txn.mapped_to);
    const isCustomer = parsed.type === "Customer";
    if (!isCustomer && parsed.type !== "Vendor") throw new UnknownMappingTypeError(parsed.type);

    const { rows: acctRows } = await client.query(`select coa_id from bank_accounts where id = $1`, [txn.bank_account_id]);
    if (acctRows.length === 0) throw new BankAccountNotFoundError(txn.bank_account_id);
    const { rows: bankCoaRows } = await client.query(`select account_code from chart_of_accounts where id = $1`, [acctRows[0].coa_id]);
    if (bankCoaRows.length === 0) throw new LedgerAccountNotMappedError();
    const bankAccountCode = bankCoaRows[0].account_code;

    const amt = Number(txn.debit) || Number(txn.credit) || 0;
    const partyId = Number(parsed.refId);

    let jeNo: string;
    if (isCustomer) {
      const draft = await createDraftReceipt(client, {
        customerId: partyId,
        receiptDate: txn.transaction_date,
        amount: amt,
        bankAccountCode,
        allocations: allocations.map((a) => ({ salesInvoiceId: a.invoiceId, allocatedAmount: a.amount })),
        narration: `Bank txn: ${txn.description || ""}`,
        userId,
      });
      const posted = await postReceipt(client, draft.id, userId);
      jeNo = posted.receipt_no;
    } else {
      const draft = await createDraftPayment(client, {
        vendorId: partyId,
        paymentDate: txn.transaction_date,
        amount: amt,
        bankAccountCode,
        allocations: allocations.map((a) => ({ purchaseInvoiceId: a.invoiceId, allocatedAmount: a.amount })),
        narration: `Bank txn: ${txn.description || ""}`,
        userId,
      });
      const posted = await postPayment(client, draft.id, userId);
      jeNo = posted.payment_no;
    }

    await client.query(
      `update bank_transactions set mapping_status = 'Posted', updated_at = now() where id = $1`,
      [transactionId],
    );
    await writeAudit(client, {
      userId, action: "post", module: "bank_transactions",
      recordId: transactionId, oldValue: { mapping_status: "Mapped" }, newValue: { mapping_status: "Posted", je_no: jeNo },
    });

    return { jeNo };
  });
}

/**
 * ONE-TIME BACKFILL — for bank accounts created before
 * createBankAccount() started posting a real opening-balance journal
 * entry automatically. Finds every account with a nonzero opening
 * balance and no existing 'bank_account_opening' entry, and posts the
 * same entry createBankAccount() would have posted at creation time.
 *
 * Safe to call more than once — accounts that already have their
 * opening entry posted are skipped, not double-posted.
 */
export async function backfillOpeningBalances(userId: number | null) {
  return withTransaction(async (client) => {
    const { rows: accounts } = await client.query(
      `select ba.id, ba.account_name, ba.opening_balance, coa.account_code as ledger_account_code
       from bank_accounts ba
       join chart_of_accounts coa on coa.id = ba.coa_id
       where ba.opening_balance is not null and ba.opening_balance != 0
         and not exists (
           select 1 from journal_entries je
           where je.source_type = 'bank_account_opening' and je.source_id = ba.id
         )`,
    );

    const results: Array<{ accountId: number; accountName: string; jeNo: string }> = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const acc of accounts) {
      const amount = Number(acc.opening_balance);
      const { jeNo } = await postJournalEntry(client, {
        entryDate: today,
        narration: `Opening balance — ${acc.account_name} (backfilled)`,
        sourceType: "bank_account_opening",
        sourceId: acc.id,
        userId,
        lines: [
          { accountCode: acc.ledger_account_code, debit: amount, credit: 0 },
          { accountCode: "3000", debit: 0, credit: amount },
        ],
      });
      results.push({ accountId: acc.id, accountName: acc.account_name, jeNo });
    }

    return { postedCount: results.length, posted: results };
  });
}

export const EXPECTED_BANK_POSTING_ERRORS = [
  UnbalancedEntryError,
  InsufficientLinesError,
  UnknownAccountError,
  FinancialYearClosedError,
  PeriodLockedError,
  NoFinancialYearError,
  BankAccountNotFoundError,
  BankTransactionNotFoundError,
  LedgerAccountNotMappedError,
  UnknownMappingTypeError,
  TransactionAlreadyPostedError,
  TransactionNotMappedError,
  AccountMappingNotConfiguredError,
  TransferMismatchError,
  TransferSameAccountError,
  SameAccountError,
  InvalidContraAccountError,
  DuplicateBankLedgerError,
  DuplicateBankAccountNumberError,
];
