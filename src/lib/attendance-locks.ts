import type { PgClient } from "../db/pool.ts";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";

export class AttendanceLockedError extends Error {
  constructor(attendanceDate: string) {
    super(`Attendance for ${attendanceDate} is locked and cannot be modified. An authorized HR user must unlock it first.`);
    this.name = "AttendanceLockedError";
  }
}

export class LockNotFoundError extends Error {
  constructor(id: number) {
    super(`Attendance lock ${id} not found.`);
    this.name = "LockNotFoundError";
  }
}

function firstOfMonth(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * The one check every attendance write path (import commit, manual
 * entry, correction application) must call before writing. Locked if
 * an active daily lock exists for the exact date, OR an active
 * monthly lock exists for that date's month. Called with the
 * caller's own transaction client so the lock check and the write it
 * guards happen against a consistent view of the same transaction.
 */
export async function assertNotLocked(client: PgClient, attendanceDate: string): Promise<void> {
  const { rows } = await client.query(
    `select 1 from attendance_locks
     where is_active = true
       and (
         (lock_type = 'daily' and period_date = $1::date)
         or (lock_type = 'monthly' and period_date = $2::date)
       )
     limit 1`,
    [attendanceDate, firstOfMonth(attendanceDate)],
  );
  if (rows.length > 0) throw new AttendanceLockedError(attendanceDate);
}

export async function lockPeriod(actorUserId: number, lockType: "daily" | "monthly", periodDate: string) {
  return withTransaction(async (client) => {
    const normalizedDate = lockType === "monthly" ? firstOfMonth(periodDate) : periodDate;

    // Reactivate an existing (previously unlocked) row for this exact
    // period rather than accumulating duplicate lock rows every time
    // the same period is locked/unlocked/relocked — the history of
    // WHO did it each time still lives in audit_log, which is exactly
    // what that log is for; this table only needs to answer "is it
    // locked right now."
    const { rows: existing } = await client.query(
      `select * from attendance_locks where lock_type = $1 and period_date = $2`,
      [lockType, normalizedDate],
    );

    let result;
    if (existing.length > 0) {
      const { rows } = await client.query(
        `update attendance_locks set is_active = true, locked_by = $2, locked_at = now(), unlocked_by = null, unlocked_at = null
         where id = $1 returning *`,
        [existing[0].id, actorUserId],
      );
      result = rows[0];
    } else {
      const { rows } = await client.query(
        `insert into attendance_locks (lock_type, period_date, locked_by) values ($1, $2, $3) returning *`,
        [lockType, normalizedDate, actorUserId],
      );
      result = rows[0];
    }

    await writeAudit(client, {
      userId: actorUserId,
      action: "update",
      module: "attendance_locks",
      recordId: result.id,
      newValue: result,
    });
    return result;
  });
}

export async function unlockPeriod(actorUserId: number, lockId: number) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from attendance_locks where id = $1`, [lockId]);
    if (existing.length === 0) throw new LockNotFoundError(lockId);

    const { rows } = await client.query(
      `update attendance_locks set is_active = false, unlocked_by = $2, unlocked_at = now() where id = $1 returning *`,
      [lockId, actorUserId],
    );
    // Every unlock is independently audited (per the spec's explicit
    // requirement), distinct from the "update" audit action lockPeriod
    // uses, so unlock events are unambiguously identifiable in the
    // audit trail rather than looking like any other update.
    await writeAudit(client, {
      userId: actorUserId,
      action: "update",
      module: "attendance_locks",
      recordId: lockId,
      oldValue: existing[0],
      newValue: { ...rows[0], _event: "unlock" },
    });
    return rows[0];
  });
}

export async function listLocks(filters: { lockType?: string; activeOnly?: boolean }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.lockType) { params.push(filters.lockType); conditions.push(`lock_type = $${params.length}`); }
  if (filters.activeOnly) { conditions.push(`is_active = true`); }
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(`select * from attendance_locks ${where} order by period_date desc`, params);
  return rows;
}
