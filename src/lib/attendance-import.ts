import type { PgClient } from "../db/pool.ts";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";
import { upsertAttendanceRecord } from "./attendance.ts";
import { parseFile, type ParsedFile } from "./bank-import.ts";

/**
 * Biometric Import Engine — mirrors schema-bankimport.sql /
 * lib/bank-import.ts's mapping_templates -> batches -> rows shape
 * exactly, per the reuse plan disclosed in HR_MODULE_MILESTONE_1.md.
 * `parseFile` is imported directly from lib/bank-import.ts rather than
 * reimplemented — it was already fully generic (headers + rows, no
 * bank-specific knowledge), so duplicating it here would just be a
 * second copy of the same CSV/XLSX parsing logic to keep in sync.
 *
 * Vendor independence: nothing in this file, or in
 * attendance_mapping_templates.column_mapping, hardcodes a specific
 * biometric vendor's column names or file layout. A new vendor is
 * supported by creating a new mapping template, never a code change.
 */

export class EmptyAttendanceFileError extends Error {
  constructor() { super("The uploaded file has no data rows."); this.name = "EmptyAttendanceFileError"; }
}
export class AttendanceMappingIncompleteError extends Error {
  constructor(missing: string[]) {
    super(`Column mapping is incomplete — missing: ${missing.join(", ")}.`);
    this.name = "AttendanceMappingIncompleteError";
  }
}
export class AttendanceBatchNotFoundError extends Error {
  constructor(id: number) { super(`Attendance import batch ${id} not found.`); this.name = "AttendanceBatchNotFoundError"; }
}
export class BatchAlreadyCommittedError extends Error {
  constructor(id: number) { super(`Batch ${id} has already been committed and cannot be committed again.`); this.name = "BatchAlreadyCommittedError"; }
}
export class BatchNotCommittedError extends Error {
  constructor(id: number) { super(`Batch ${id} has not been committed — nothing to roll back.`); this.name = "BatchNotCommittedError"; }
}

export const REQUIRED_FIELDS = ["employeeCode", "attendanceDate"] as const;
export const OPTIONAL_FIELDS = ["employeeIdRaw", "employeeNameRaw", "inTime", "outTime", "shiftCode", "deviceId", "statusRaw"] as const;
export type MappableField = typeof REQUIRED_FIELDS[number] | typeof OPTIONAL_FIELDS[number];

export function autoDetectMapping(headers: string[]): Partial<Record<MappableField, string>> {
  const patterns: Record<MappableField, RegExp> = {
    employeeCode: /\b(emp(loyee)?\s*code|emp\s*no|staff\s*id)\b/i,
    employeeIdRaw: /\b(emp(loyee)?\s*id|biometric\s*id)\b/i,
    employeeNameRaw: /\b(emp(loyee)?\s*name|name)\b/i,
    attendanceDate: /\bdate\b/i,
    inTime: /\bin[\s_-]*time\b|\bpunch\s*in\b/i,
    outTime: /\bout[\s_-]*time\b|\bpunch\s*out\b/i,
    shiftCode: /\bshift\b/i,
    deviceId: /\bdevice\b/i,
    statusRaw: /\bstatus\b/i,
  };
  const mapping: Partial<Record<MappableField, string>> = {};
  for (const header of headers) {
    for (const [field, pattern] of Object.entries(patterns) as [MappableField, RegExp][]) {
      if (mapping[field]) continue;
      if (pattern.test(header)) mapping[field] = header;
    }
  }
  return mapping;
}

export function missingRequiredFields(mapping: Partial<Record<MappableField, string>>): string[] {
  return REQUIRED_FIELDS.filter((f) => !mapping[f]);
}

export interface MappedAttendanceRow {
  rowNumber: number;
  employeeCodeRaw: string;
  employeeIdRaw: string;
  employeeNameRaw: string;
  attendanceDateRaw: string;
  inTimeRaw: string;
  outTimeRaw: string;
  shiftCodeRaw: string;
  deviceId: string;
  statusRaw: string;
}

export function applyMapping(parsed: ParsedFile, mapping: Partial<Record<MappableField, string>>): MappedAttendanceRow[] {
  const missing = missingRequiredFields(mapping);
  if (missing.length > 0) throw new AttendanceMappingIncompleteError(missing);

  const idx: Partial<Record<MappableField, number>> = {};
  for (const field of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const header = mapping[field];
    if (header) idx[field] = parsed.headers.indexOf(header);
  }
  const get = (row: string[], field: MappableField) => (idx[field] != null ? row[idx[field]!] ?? "" : "");

  return parsed.rows.map((row, i) => ({
    rowNumber: i + 1,
    employeeCodeRaw: get(row, "employeeCode").trim(),
    employeeIdRaw: get(row, "employeeIdRaw").trim(),
    employeeNameRaw: get(row, "employeeNameRaw").trim(),
    attendanceDateRaw: get(row, "attendanceDate").trim(),
    inTimeRaw: get(row, "inTime").trim(),
    outTimeRaw: get(row, "outTime").trim(),
    shiftCodeRaw: get(row, "shiftCode").trim(),
    deviceId: get(row, "deviceId").trim(),
    statusRaw: get(row, "statusRaw").trim(),
  }));
}

/** Same accepted formats as the bank import engine (ISO, dd/mm/yyyy, dd-mm-yyyy) — deliberately not a generic free-text parser, for the same reason: silently misreading dd/mm vs mm/dd would be a real attendance error, not a parsing nicety. */
function parseDate(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  let m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = trimmed.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    if (Number(month) > 12) return null;
    return `${m[3]}-${month}-${day}`;
  }
  return null;
}

/** Accepts 24-hour (HH:MM, HH:MM:SS) and 12-hour ("hh:mm AM/PM") formats — biometric device exports use both depending on vendor/locale, and this is exactly the vendor-independence the import engine is meant to provide. Returns 24-hour "HH:MM:SS" or null. */
function parseTime(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  let m = trimmed.match(/^(\d{1,2}):(\d{2})(:(\d{2}))?$/);
  if (m) {
    const h = Number(m[1]), min = Number(m[2]), s = Number(m[4] ?? 0);
    if (h > 23 || min > 59 || s > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  m = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 12 || min > 59) return null;
    const isPM = m[3].toUpperCase() === "PM";
    if (h === 12) h = isPM ? 12 : 0;
    else if (isPM) h += 12;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
  }
  return null;
}

/**
 * Combines attendanceDate + a time-of-day into a timestamp, handling
 * the case where outTime is numerically earlier than inTime (a night
 * shift crossing midnight) by rolling the date forward one day —
 * same cross-day reasoning as lib/attendance-processing.ts applies to
 * shift start/end times, applied here to raw punch times before
 * they're even compared against a shift.
 */
function combineDateTime(dateIso: string, timeStr: string, rollForwardIfBefore: string | null): string {
  if (rollForwardIfBefore && timeStr < rollForwardIfBefore) {
    const d = new Date(`${dateIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const nextDay = d.toISOString().slice(0, 10);
    return `${nextDay}T${timeStr}`;
  }
  return `${dateIso}T${timeStr}`;
}

export interface ValidatedAttendanceRow {
  rowNumber: number;
  employeeCodeRaw: string;
  attendanceDate: string | null;
  inTimeParsed: string | null;
  outTimeParsed: string | null;
  resolvedEmployeeId: number | null;
  resolvedShiftId: number | null;
  status: "valid" | "rejected" | "duplicate" | "merged";
  rejectionReason: string | null;
}

/**
 * Validates and resolves every row against real HR data, THEN
 * aggregates multiple rows for the same employee+date within one
 * file into a single first-in/last-out entry — this is a Domain
 * Review correction to the original Milestone 3 behavior, which
 * treated any second row for the same employee+date as an outright
 * 'duplicate' (discarded). That was wrong for a real, common source
 * format: a biometric export with one row PER PUNCH EVENT (clock-in,
 * lunch-out, lunch-in, clock-out) legitimately has several rows for
 * one employee on one date, and they should be merged into first-in/
 * last-out, not thrown away. A genuine duplicate — the same
 * employee+date already committed as a real attendance_records row,
 * from an earlier batch — is still detected and still marked
 * 'duplicate'; only the WITHIN-FILE same-day case changed from
 * "reject the repeat" to "merge it."
 *
 * This does not attempt to merge across a calendar-date boundary (a
 * night shift's punches legitimately spanning two dates in the raw
 * file) — that remains a known, documented limitation (see
 * HR_MODULE_MILESTONE_3_DOMAIN_REVIEW.md §3), not silently guessed at.
 */
export async function validateAndResolveRows(client: PgClient, rows: MappedAttendanceRow[]): Promise<ValidatedAttendanceRow[]> {
  const results: ValidatedAttendanceRow[] = [];
  // Groups rows that parsed/resolved successfully, keyed by
  // employeeId:date, in file order — used for the aggregation pass below.
  const groups = new Map<string, number[]>(); // key -> indices into `results`

  for (const row of rows) {
    const attendanceDate = parseDate(row.attendanceDateRaw);
    if (!row.employeeCodeRaw) {
      results.push({ rowNumber: row.rowNumber, employeeCodeRaw: row.employeeCodeRaw, attendanceDate, inTimeParsed: null, outTimeParsed: null, resolvedEmployeeId: null, resolvedShiftId: null, status: "rejected", rejectionReason: "Missing employee code." });
      continue;
    }
    if (!attendanceDate) {
      results.push({ rowNumber: row.rowNumber, employeeCodeRaw: row.employeeCodeRaw, attendanceDate: null, inTimeParsed: null, outTimeParsed: null, resolvedEmployeeId: null, resolvedShiftId: null, status: "rejected", rejectionReason: `Invalid or missing date: "${row.attendanceDateRaw}"` });
      continue;
    }

    const { rows: empRows } = await client.query(
      `select em.employee_id from employee_master em where lower(em.employee_code) = lower($1)`,
      [row.employeeCodeRaw],
    );
    if (empRows.length === 0) {
      results.push({ rowNumber: row.rowNumber, employeeCodeRaw: row.employeeCodeRaw, attendanceDate, inTimeParsed: null, outTimeParsed: null, resolvedEmployeeId: null, resolvedShiftId: null, status: "rejected", rejectionReason: `Unknown employee code: "${row.employeeCodeRaw}"` });
      continue;
    }
    const resolvedEmployeeId = empRows[0].employee_id;

    let inTime: string | null = null;
    let outTime: string | null = null;
    if (row.inTimeRaw) {
      inTime = parseTime(row.inTimeRaw);
      if (!inTime) {
        results.push({ rowNumber: row.rowNumber, employeeCodeRaw: row.employeeCodeRaw, attendanceDate, inTimeParsed: null, outTimeParsed: null, resolvedEmployeeId, resolvedShiftId: null, status: "rejected", rejectionReason: `Invalid in-time: "${row.inTimeRaw}"` });
        continue;
      }
    }
    if (row.outTimeRaw) {
      outTime = parseTime(row.outTimeRaw);
      if (!outTime) {
        results.push({ rowNumber: row.rowNumber, employeeCodeRaw: row.employeeCodeRaw, attendanceDate, inTimeParsed: null, outTimeParsed: null, resolvedEmployeeId, resolvedShiftId: null, status: "rejected", rejectionReason: `Invalid out-time: "${row.outTimeRaw}"` });
        continue;
      }
    }

    let resolvedShiftId: number | null = null;
    if (row.shiftCodeRaw) {
      const { rows: shiftRows } = await client.query(`select id from shifts where lower(shift_code) = lower($1)`, [row.shiftCodeRaw]);
      resolvedShiftId = shiftRows[0]?.id ?? null;
      // An unrecognized shift code is informational only, not
      // rejected — actual processing always uses the employee's real
      // assignment (see attendance-processing.ts), so a typo'd shift
      // column in the source file doesn't block the punch data itself.
    }

    const index = results.length;
    results.push({ rowNumber: row.rowNumber, employeeCodeRaw: row.employeeCodeRaw, attendanceDate, inTimeParsed: inTime, outTimeParsed: outTime, resolvedEmployeeId, resolvedShiftId, status: "valid", rejectionReason: null });
    const key = `${resolvedEmployeeId}:${attendanceDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(index);
  }

  // Aggregation pass: for any employee+date with more than one
  // successfully-parsed row, fold them into the first row (earliest
  // in file order) with first-in/last-out, and mark the rest 'merged'.
  for (const indices of groups.values()) {
    if (indices.length <= 1) continue;
    const primaryIndex = indices[0];
    const primary = results[primaryIndex];
    const inTimes = indices.map((i) => results[i].inTimeParsed).filter((t): t is string => t != null);
    const outTimes = indices.map((i) => results[i].outTimeParsed).filter((t): t is string => t != null);
    primary.inTimeParsed = inTimes.length > 0 ? inTimes.sort()[0] : null;
    primary.outTimeParsed = outTimes.length > 0 ? outTimes.sort().at(-1)! : null;
    for (const i of indices.slice(1)) {
      results[i].status = "merged";
      results[i].rejectionReason = `Merged into row ${primary.rowNumber}'s aggregated first-in/last-out for this employee and date.`;
    }
  }

  // Cross-batch duplicate check: only against rows still 'valid'
  // after aggregation (i.e. exactly the primary row per employee+date).
  for (const row of results) {
    if (row.status !== "valid") continue;
    const { rows: existingRecord } = await client.query(
      `select 1 from attendance_records where employee_id = $1 and attendance_date = $2`,
      [row.resolvedEmployeeId, row.attendanceDate],
    );
    if (existingRecord.length > 0) {
      row.status = "duplicate";
      row.rejectionReason = "An attendance record already exists for this employee and date.";
    }
  }

  return results;
}

/** Preview: parses, maps, validates, and persists a batch + its rows — but writes nothing to attendance_records. This is the "Preview Before Import" step; nothing here is visible outside the import screens until commitAttendanceImport() runs. */
export async function previewAttendanceImport(
  fileName: string,
  parsed: ParsedFile,
  mapping: Partial<Record<MappableField, string>>,
  mappingTemplateId: number | null,
  actorUserId: number | null,
) {
  return withTransaction(async (client) => {
    const mappedRows = applyMapping(parsed, mapping);
    if (mappedRows.length === 0) throw new EmptyAttendanceFileError();
    const validated = await validateAndResolveRows(client, mappedRows);

    const rowsValid = validated.filter((r) => r.status === "valid").length;
    const rowsRejected = validated.filter((r) => r.status === "rejected").length;
    // 'merged' rows are folded into the duplicate summary count for
    // the batch-level rollup (batches has no separate rows_merged
    // column) — neither ends up as its own attendance_records row.
    // The distinction is preserved per-row (see /import/:batchId/rows
    // and /import/:batchId/errors?status=merged), which is where it
    // actually matters for review.
    const rowsDuplicate = validated.filter((r) => r.status === "duplicate" || r.status === "merged").length;

    const { rows: batchRows } = await client.query(
      `insert into attendance_import_batches (file_name, mapping_template_id, status, total_rows, rows_valid, rows_rejected, rows_duplicate, imported_by)
       values ($1,$2,'previewed',$3,$4,$5,$6,$7) returning *`,
      [fileName, mappingTemplateId, validated.length, rowsValid, rowsRejected, rowsDuplicate, actorUserId],
    );
    const batch = batchRows[0];

    for (const row of validated) {
      const original = mappedRows.find((m) => m.rowNumber === row.rowNumber)!;
      await client.query(
        `insert into attendance_import_rows (
           batch_id, row_number, employee_code_raw, employee_name_raw, attendance_date_raw, in_time_raw, out_time_raw,
           shift_code_raw, device_id, status_raw, resolved_employee_id, resolved_shift_id, attendance_date, status, rejection_reason
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          batch.id, row.rowNumber, original.employeeCodeRaw, original.employeeNameRaw, original.attendanceDateRaw,
          row.inTimeParsed, row.outTimeParsed, original.shiftCodeRaw, original.deviceId, original.statusRaw,
          row.resolvedEmployeeId, row.resolvedShiftId, row.attendanceDate, row.status, row.rejectionReason,
        ],
      );
    }

    await writeAudit(client, { userId: actorUserId, action: "create", module: "attendance_import_batches", recordId: batch.id, newValue: batch });
    return { batch, rows: validated };
  });
}

/**
 * Commit: writes real attendance_records rows for every eligible row
 * in the batch, via the SAME upsertAttendanceRecord() every other
 * write path uses. Rejected/duplicate/merged rows are never committed.
 *
 * Domain Review fix: each row is committed in its OWN transaction,
 * not one transaction for the whole batch. The original Milestone 3
 * version wrapped the entire loop in a single withTransaction() call
 * — meaning one problem row (e.g. its date got locked between preview
 * and commit) would roll back every other row that would otherwise
 * have succeeded, on a batch that could be hundreds of rows. A
 * failing row is now recorded as 'commit_failed' with its specific
 * reason, and the rest of the batch proceeds. Calling this function
 * again on the same batch retries exactly the rows still eligible
 * ('valid' or 'commit_failed') — 'committed' rows are skipped, so
 * commit is safe to re-run after fixing whatever blocked the failed
 * rows (e.g. unlocking a date), without re-processing everything.
 */
export async function commitAttendanceImport(actorUserId: number | null, batchId: number) {
  const batch = await getBatch(batchId);
  if (batch.status === "committed" && batch.rows_committed === batch.rows_valid) {
    throw new BatchAlreadyCommittedError(batchId);
  }

  const { rows: eligibleRows } = await query(
    `select * from attendance_import_rows where batch_id = $1 and status in ('valid', 'commit_failed')`,
    [batchId],
  );

  let committedThisRun = 0;
  let failedThisRun = 0;
  for (const row of eligibleRows) {
    try {
      await withTransaction(async (client) => {
        // FIX: the `pg` driver parses a Postgres `date` column into a
        // JS Date object, not a string — row.attendance_date is a Date
        // here, not "2024-02-05". combineDateTime() (and attendanceDate
        // below) do plain string interpolation, so passing the Date
        // object through directly triggered its implicit .toString()
        // ("Mon Feb 05 2024 00:00:00 GMT+0000 (...)"), which then got
        // "T09:05:00" glued onto the end — a value Postgres correctly
        // rejected as an invalid timestamp. Normalize to a real ISO
        // date string once, up front, and use that everywhere below.
        const attendanceDateIso = row.attendance_date instanceof Date
          ? row.attendance_date.toISOString().slice(0, 10)
          : String(row.attendance_date);

        const inTimestamp = row.in_time_raw && attendanceDateIso
          ? combineDateTime(attendanceDateIso, parseTime(row.in_time_raw) ?? "00:00:00", null)
          : null;
        let outTimestamp: string | null = null;
        if (row.out_time_raw && attendanceDateIso) {
          const outParsed = parseTime(row.out_time_raw) ?? "00:00:00";
          const inParsed = row.in_time_raw ? parseTime(row.in_time_raw) : null;
          outTimestamp = combineDateTime(attendanceDateIso, outParsed, inParsed);
        }

        await upsertAttendanceRecord(client, actorUserId, {
          employeeId: row.resolved_employee_id,
          attendanceDate: attendanceDateIso,
          inTimestamp,
          outTimestamp,
          source: "biometric_import",
          importBatchId: batchId,
        });
        await client.query(`update attendance_import_rows set status = 'committed' where id = $1`, [row.id]);
      });
      committedThisRun++;
    } catch (err) {
      failedThisRun++;
      const reason = err instanceof Error ? err.message : String(err);
      await query(`update attendance_import_rows set status = 'commit_failed', rejection_reason = $2 where id = $1`, [row.id, reason]);
    }
  }

  const { rows: totalCommittedRows } = await query(
    `select count(*) from attendance_import_rows where batch_id = $1 and status = 'committed'`,
    [batchId],
  );
  const totalCommitted = Number(totalCommittedRows[0].count);

  // A batch with zero rows ever committed (out of at least one
  // attempted) is 'failed'; any batch with at least one committed row
  // is 'committed', even if some rows are still 'commit_failed' —
  // rows_committed vs rows_valid tells the caller whether it was a
  // full or partial success, without inventing a third batch-status value.
  const newStatus = totalCommitted === 0 && eligibleRows.length > 0 ? "failed" : "committed";

  return withTransaction(async (client) => {
    const { rows: updatedBatch } = await client.query(
      `update attendance_import_batches set status = $2, rows_committed = $3, committed_at = now() where id = $1 returning *`,
      [batchId, newStatus, totalCommitted],
    );
    await writeAudit(client, {
      userId: actorUserId,
      action: "post",
      module: "attendance_import_batches",
      recordId: batchId,
      newValue: { ...updatedBatch[0], _committedThisRun: committedThisRun, _failedThisRun: failedThisRun },
    });
    return updatedBatch[0];
  });
}

/** Rollback: only for a committed batch, only reverses records that still carry this batch's import_batch_id (so a subsequent manual correction on one of those records is never silently clobbered — the delete is scoped to source='biometric_import' AND this batch, and a record that's since been corrected has source='correction' and is deliberately left alone). */
export async function rollbackAttendanceImport(actorUserId: number, batchId: number) {
  return withTransaction(async (client) => {
    const { rows: batchRows } = await client.query(`select * from attendance_import_batches where id = $1`, [batchId]);
    if (batchRows.length === 0) throw new AttendanceBatchNotFoundError(batchId);
    if (batchRows[0].status !== "committed") throw new BatchNotCommittedError(batchId);

    const { rows: toDelete } = await client.query(
      `select * from attendance_records where import_batch_id = $1 and source = 'biometric_import'`,
      [batchId],
    );
    for (const record of toDelete) {
      await client.query(`delete from attendance_records where id = $1`, [record.id]);
      await writeAudit(client, { userId: actorUserId, action: "cancel", module: "attendance_records", recordId: record.id, oldValue: record });
    }

    const { rows: updatedBatch } = await client.query(
      `update attendance_import_batches set status = 'rolled_back', rolled_back_at = now(), rolled_back_by = $2 where id = $1 returning *`,
      [batchId, actorUserId],
    );
    await writeAudit(client, { userId: actorUserId, action: "cancel", module: "attendance_import_batches", recordId: batchId, newValue: updatedBatch[0] });
    return { batch: updatedBatch[0], recordsRemoved: toDelete.length };
  });
}

export async function getBatch(batchId: number) {
  const { rows } = await query(`select * from attendance_import_batches where id = $1`, [batchId]);
  if (rows.length === 0) throw new AttendanceBatchNotFoundError(batchId);
  return rows[0];
}

export async function listBatches() {
  const { rows } = await query(`select * from attendance_import_batches order by imported_at desc`);
  return rows;
}

export async function getBatchRows(batchId: number, statusFilter?: string) {
  const params: unknown[] = [batchId];
  let where = `batch_id = $1`;
  if (statusFilter) { params.push(statusFilter); where += ` and status = $2`; }
  const { rows } = await query(`select * from attendance_import_rows where ${where} order by row_number`, params);
  return rows;
}

export async function saveMappingTemplate(templateName: string, columnMapping: Record<string, string>, createdBy: number | null) {
  const { rows } = await query(
    `insert into attendance_mapping_templates (template_name, column_mapping, created_by) values ($1,$2,$3)
     on conflict (template_name) do update set column_mapping = excluded.column_mapping
     returning *`,
    [templateName, JSON.stringify(columnMapping), createdBy],
  );
  return rows[0];
}

export async function listMappingTemplates() {
  const { rows } = await query(`select * from attendance_mapping_templates order by template_name`);
  return rows;
}
