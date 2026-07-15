import type { PgClient } from "../db/pool.ts";

export type AuditEntry = {
  userId: number | null;
  action: "create" | "post" | "cancel" | "reverse" | "update" | "deactivate";
  module: string;
  recordId: number | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
};

/**
 * Writes one audit row. Called inside the same transaction as the
 * change it's recording, so an audit-write failure rolls back the
 * change too — an accounting action that can't be logged doesn't
 * happen at all.
 */
export async function writeAudit(client: PgClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `insert into audit_log (user_id, action, module, record_id, old_value, new_value, ip_address)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.userId,
      entry.action,
      entry.module,
      entry.recordId,
      entry.oldValue ? JSON.stringify(entry.oldValue) : null,
      entry.newValue ? JSON.stringify(entry.newValue) : null,
      entry.ipAddress ?? null,
    ],
  );
}
