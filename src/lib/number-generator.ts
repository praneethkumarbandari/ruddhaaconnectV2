import type { PgClient } from "../db/pool.ts";

/**
 * Generates the next document number for a given type + financial year,
 * atomically, inside the caller's already-open transaction.
 *
 * How it avoids the race condition that plagued the old backend
 * (two concurrent requests both reading the same "current max" and
 * computing the same "next" number):
 *
 *   `SELECT ... FOR UPDATE` takes a row lock on the specific
 *   (document_type, financial_year_id) row in numbering_sequences.
 *   A second concurrent call for the *same* type+year blocks until
 *   the first transaction commits or rolls back — at which point it
 *   sees the already-incremented value. Calls for *different*
 *   type+year pairs don't block each other at all, since they lock
 *   different rows.
 *
 * MUST be called with the transaction client from withTransaction().
 * Calling it with a standalone connection defeats the lock entirely,
 * because the row lock is released as soon as that implicit
 * transaction ends — before the caller's insert happens.
 */
export async function nextDocumentNumber(
  client: PgClient,
  documentType: string,
  financialYearId: number,
): Promise<string> {
  // Row must exist before it can be locked; create it on first use.
  await client.query(
    `insert into numbering_sequences (document_type, financial_year_id, prefix, next_number, padding)
     values ($1, $2, $3, 1, 4)
     on conflict (document_type, financial_year_id) do nothing`,
    [documentType, financialYearId, defaultPrefix(documentType)],
  );

  const { rows } = await client.query(
    `select id, prefix, separator, next_number, padding, suffix
     from numbering_sequences
     where document_type = $1 and financial_year_id = $2
     for update`,
    [documentType, financialYearId],
  );

  const seq = rows[0];
  const current: number = seq.next_number;

  await client.query(
    `update numbering_sequences set next_number = next_number + 1, updated_at = now() where id = $1`,
    [seq.id],
  );

  // FIX: this used to always return `${prefix}${padded}` — separator
  // and suffix were configurable in Settings (content/settings.html's
  // Numbering & Prefixes tab) but silently had zero effect on the
  // actual number generated at save time, no matter what was entered
  // there. A financial year's-first-run row (just inserted above) has
  // no separator/suffix yet, hence the `?? ''` fallback — genuinely
  // absent, not a bug, since the insert above only sets prefix.
  const padded = String(current).padStart(seq.padding, "0");
  return `${seq.prefix}${seq.separator ?? ""}${padded}${seq.suffix ?? ""}`;
}

function defaultPrefix(documentType: string): string {
  const prefixes: Record<string, string> = {
    journal_entry: "JE-",
    invoice: "INV-",
    receipt: "RCP-",
    payment: "PAY-",
    purchase: "PUR-",
    contra: "CON-",
    credit_note: "CN-",
    debit_note: "DN-",
    // FIX: these three document types (added for the Invoice Engine)
    // were missing from this map entirely, so they were silently
    // falling through to the generic ${TYPE_NAME}- fallback below —
    // functional, but inconsistent with the short prefixes every
    // other document type gets.
    sales_invoice: "SI-",
    purchase_invoice: "PI-",
    goods_return: "GR-",
  };
  return prefixes[documentType] ?? `${documentType.toUpperCase()}-`;
}
