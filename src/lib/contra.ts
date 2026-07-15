import type { PgClient } from "../db/pool.ts";
import { postJournalEntry, type PostingLineInput } from "./posting-engine.ts";
import { requireOpenFinancialYear } from "./fy.ts";
import { nextDocumentNumber } from "./number-generator.ts";

export class SameAccountError extends Error {
  constructor() {
    super("A contra entry must move money between two different accounts.");
    this.name = "SameAccountError";
  }
}

export class InvalidContraAccountError extends Error {
  constructor(code: string) {
    super(`Account ${code} is not a valid contra account (must be an active asset account).`);
    this.name = "InvalidContraAccountError";
  }
}

export type ContraInput = {
  entryDate: string;
  fromAccountCode: string; // money leaves this account
  toAccountCode: string;   // money arrives in this account
  amount: number;
  narration?: string;
  userId: number | null;
  projectId?: number | null; // Project Management tag — see posting-engine.ts's JournalEntryInput
};

/**
 * Contra: cash <-> bank or bank <-> bank movement. No income, no
 * expense — always Dr the destination / Cr the source, both asset
 * accounts. Reuses postJournalEntry() directly; there is no separate
 * "contra posting" code path, this function only assembles the two
 * lines and validates the accounts are asset-type before calling it.
 */
export async function postContra(client: PgClient, input: ContraInput) {
  if (input.fromAccountCode === input.toAccountCode) throw new SameAccountError();

  for (const code of [input.fromAccountCode, input.toAccountCode]) {
    const { rows } = await client.query(
      `select account_type from chart_of_accounts where account_code = $1 and is_active = true`,
      [code],
    );
    if (rows.length === 0 || rows[0].account_type !== "asset") {
      throw new InvalidContraAccountError(code);
    }
  }

  const fy = await requireOpenFinancialYear(client, input.entryDate);
  const contraNo = await nextDocumentNumber(client, "contra", fy.id);

  const lines: PostingLineInput[] = [
    { accountCode: input.toAccountCode, debit: input.amount, credit: 0, narration: `Contra ${contraNo}` },
    { accountCode: input.fromAccountCode, debit: 0, credit: input.amount, narration: `Contra ${contraNo}` },
  ];

  return postJournalEntry(client, {
    entryDate: input.entryDate,
    narration: input.narration ?? `Contra ${contraNo}: ${input.fromAccountCode} to ${input.toAccountCode}`,
    sourceType: "contra",
    lines,
    userId: input.userId,
    projectId: input.projectId ?? null,
  });
}
