import type { PgClient } from "../db/pool.ts";

/**
 * Core attendance calculation engine. Deliberately has no knowledge
 * of imports, corrections, or HTTP — it takes punch data in, and
 * returns computed fields out. Both the import commit path
 * (lib/attendance-import.ts) and the correction-application path
 * (lib/attendance-corrections.ts) call this SAME function, so "how is
 * late/overtime computed" has exactly one implementation regardless
 * of how the punch data arrived.
 *
 * All date/time arithmetic is done in a single Postgres query rather
 * than in JavaScript `Date` math, specifically to avoid a Node-server-
 * timezone vs. Postgres-session-timezone mismatch: `shifts.start_time`/
 * `end_time` are plain `time` (no timezone), and combining them with
 * `attendance_date` (`date + time -> timestamp without time zone`)
 * then comparing against `in_timestamp`/`out_timestamp` (`timestamptz`)
 * lets Postgres resolve the comparison using its own single, consistent
 * session timezone — the same one every other date/time value in this
 * database is already interpreted in. Nothing here assumes what that
 * timezone is; it only assumes it's the same one everywhere, which is
 * already true throughout this codebase (no table anywhere stores an
 * explicit per-row timezone).
 */

export type ResolvedShift = {
  shiftId: number;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  attendancePolicyId: number | null;
} | null;

export type ResolvedPolicy = {
  policyId: number;
  graceMinutes: number;
  halfDayThresholdHours: number;
  fullDayThresholdHours: number;
  overtimeEnabled: boolean;
  overtimeThresholdMinutes: number;
  minOvertimeMinutes: number;
};

/**
 * Shift for a given employee+date: an override for that exact date
 * wins; otherwise the standing assignment whose date range covers it.
 * Returns null if the employee has no shift on this date at all —
 * a real, valid state (e.g. before their first assignment exists).
 */
export async function getShiftForDate(client: PgClient, employeeId: number, attendanceDate: string): Promise<ResolvedShift> {
  const { rows: overrideRows } = await client.query(
    `select s.id as shift_id, s.start_time, s.end_time, s.break_minutes, s.attendance_policy_id
     from shift_overrides so
     join shifts s on s.id = so.shift_id
     where so.employee_id = $1 and so.override_date = $2`,
    [employeeId, attendanceDate],
  );
  const row = overrideRows[0] ?? (
    await client.query(
      `select s.id as shift_id, s.start_time, s.end_time, s.break_minutes, s.attendance_policy_id
       from employee_shift_assignments esa
       join shifts s on s.id = esa.shift_id
       where esa.employee_id = $1
         and esa.effective_from <= $2
         and (esa.effective_to is null or esa.effective_to >= $2)
       order by esa.effective_from desc
       limit 1`,
      [employeeId, attendanceDate],
    )
  ).rows[0];

  if (!row) return null;
  return {
    shiftId: row.shift_id,
    startTime: row.start_time,
    endTime: row.end_time,
    breakMinutes: row.break_minutes,
    attendancePolicyId: row.attendance_policy_id,
  };
}

/** Falls back to the system default policy ('DEFAULT', seeded in schema-attendance.sql) if the shift has none assigned, or there's no shift at all. */
export async function getPolicyForShift(client: PgClient, policyId: number | null): Promise<ResolvedPolicy> {
  const { rows } = await client.query(
    `select * from attendance_policies where id = coalesce($1, (select id from attendance_policies where policy_code = 'DEFAULT')) and is_active = true`,
    [policyId],
  );
  if (rows.length === 0) {
    // The DEFAULT policy itself was deactivated or never seeded — a
    // genuine configuration error, not a normal "no policy" case.
    throw new Error("No active attendance policy resolved, and the system DEFAULT policy is missing or inactive. Check attendance_policies.");
  }
  const p = rows[0];
  return {
    policyId: p.id,
    graceMinutes: p.grace_minutes,
    halfDayThresholdHours: Number(p.half_day_threshold_hours),
    fullDayThresholdHours: Number(p.full_day_threshold_hours),
    overtimeEnabled: p.overtime_enabled,
    overtimeThresholdMinutes: p.overtime_threshold_minutes,
    minOvertimeMinutes: p.min_overtime_minutes,
  };
}

export async function isHoliday(client: PgClient, employeeId: number, attendanceDate: string): Promise<boolean> {
  const { rows } = await client.query(
    `select 1 from holidays h
     join employee_master em on em.employee_id = $1
     where h.holiday_date = $2 and h.is_active = true
       and (h.branch_id is null or h.branch_id = em.branch_id)
     limit 1`,
    [employeeId, attendanceDate],
  );
  return rows.length > 0;
}

export async function isWeeklyOff(client: PgClient, employeeId: number, attendanceDate: string): Promise<boolean> {
  const { rows } = await client.query(
    `select 1 from weekly_off_configurations
     where employee_id = $1 and day_of_week = extract(dow from $2::date)`,
    [employeeId, attendanceDate],
  );
  return rows.length > 0;
}

export type ComputedAttendance = {
  statusCode: "PRESENT" | "HALF_DAY" | "ABSENT" | "HOLIDAY" | "WEEKLY_OFF" | "INCOMPLETE";
  workingMinutes: number | null;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  isHalfDay: boolean;
};

/**
 * The single calculation entry point. `shift` may be null (no
 * assignment resolved for this date) — late/early/overtime are all
 * zero in that case, since there's no expected schedule to compare
 * against; only PRESENT/HALF_DAY/ABSENT can still be derived from raw
 * worked minutes using the policy's thresholds.
 */
export async function calculateAttendance(
  client: PgClient,
  params: {
    employeeId: number;
    attendanceDate: string;
    inTimestamp: string | null;
    outTimestamp: string | null;
    shift: ResolvedShift;
    policy: ResolvedPolicy;
  },
): Promise<ComputedAttendance> {
  const { employeeId, attendanceDate, inTimestamp, outTimestamp, shift, policy } = params;

  if (!inTimestamp && !outTimestamp) {
    // Genuinely no punch at all. Holiday/weekly-off take precedence
    // over "absent" — an employee isn't absent on their day off.
    if (await isHoliday(client, employeeId, attendanceDate)) {
      return { statusCode: "HOLIDAY", workingMinutes: null, lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0, isHalfDay: false };
    }
    if (await isWeeklyOff(client, employeeId, attendanceDate)) {
      return { statusCode: "WEEKLY_OFF", workingMinutes: null, lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0, isHalfDay: false };
    }
    return { statusCode: "ABSENT", workingMinutes: null, lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0, isHalfDay: false };
  }

  if (!inTimestamp || !outTimestamp) {
    // Domain Review fix: exactly ONE side of the punch pair is
    // missing — a forgotten OUT punch is one of the most common real
    // biometric-attendance scenarios, and the employee clearly did
    // show up. Classifying this as ABSENT (the original behavior)
    // was both factually wrong and operationally harsh — a real
    // grievance risk, and a real payroll/LOP risk if it silently
    // stayed that way. INCOMPLETE forces attention via the
    // correction workflow instead of quietly under-paying someone
    // who came to work. Holiday/weekly-off are NOT checked here —
    // if there's a punch at all, the day wasn't a day off, so a
    // half-punch on a day the schedule says is a holiday is itself
    // a data anomaly worth surfacing as INCOMPLETE, not silently
    // reclassified as HOLIDAY.
    return { statusCode: "INCOMPLETE", workingMinutes: null, lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0, isHalfDay: false };
  }

  const breakMinutes = shift?.breakMinutes ?? 0;

  if (!shift) {
    // Worked, but no shift resolved to compare against — still
    // compute raw working minutes and a PRESENT/HALF_DAY/ABSENT
    // verdict from the policy's hour thresholds; late/early/overtime
    // stay zero since there's no expected schedule.
    const { rows } = await client.query(
      `select round(extract(epoch from ($2::timestamptz - $1::timestamptz)) / 60) - $3 as working_minutes`,
      [inTimestamp, outTimestamp, breakMinutes],
    );
    const workingMinutes = Math.max(0, Number(rows[0].working_minutes));
    return classifyByHours(workingMinutes, policy);
  }

  const { rows } = await client.query(
    `with expected as (
       select
         ($1::date + $4::time)::timestamptz as start_ts,
         case when $5::time <= $4::time
              then (($1::date + $5::time) + interval '1 day')::timestamptz
              else ($1::date + $5::time)::timestamptz
         end as end_ts
     )
     select
       greatest(0, round(extract(epoch from ($3::timestamptz - $2::timestamptz)) / 60) - $6) as working_minutes,
       greatest(0, round(extract(epoch from ($2::timestamptz - expected.start_ts)) / 60) - $7) as late_minutes_raw,
       greatest(0, round(extract(epoch from (expected.end_ts - $3::timestamptz)) / 60) - $7) as early_exit_minutes_raw,
       round(extract(epoch from (expected.end_ts - expected.start_ts)) / 60) - $6 as expected_shift_minutes
     from expected`,
    [attendanceDate, inTimestamp, outTimestamp, shift.startTime, shift.endTime, breakMinutes, policy.graceMinutes],
  );

  const r = rows[0];
  const workingMinutes = Math.max(0, Number(r.working_minutes));
  const lateMinutes = Number(r.late_minutes_raw);
  const earlyExitMinutes = Number(r.early_exit_minutes_raw);
  const expectedShiftMinutes = Number(r.expected_shift_minutes);

  let overtimeMinutes = 0;
  if (policy.overtimeEnabled) {
    const extra = workingMinutes - expectedShiftMinutes - policy.overtimeThresholdMinutes;
    overtimeMinutes = extra >= policy.minOvertimeMinutes ? Math.round(extra) : 0;
  }

  const classified = classifyByHours(workingMinutes, policy);
  // Shift-aware full-day override — see comment above expectedShiftMinutes'
  // use here: classifyByHours' flat policy.fullDayThresholdHours assumes a
  // "typical" shift's net-of-break length. A shift whose own net duration is
  // shorter than that flat threshold can never reach PRESENT under it no
  // matter how punctual the employee is. If working minutes are within
  // grace of what THIS shift actually expects, that's a full day for this
  // shift, regardless of how it compares to another shift's flat cutoff.
  if (classified.statusCode !== "PRESENT" && workingMinutes >= expectedShiftMinutes - policy.graceMinutes) {
    return { ...classified, statusCode: "PRESENT", isHalfDay: false, lateMinutes, earlyExitMinutes, overtimeMinutes };
  }
  return { ...classified, lateMinutes, earlyExitMinutes, overtimeMinutes };
}

/**
 * PRESENT if worked hours meet the full-day threshold, HALF_DAY if
 * they meet the (lower) half-day threshold, otherwise ABSENT even
 * though some time was punched — a very brief punch-in/out (a few
 * minutes) is not a meaningfully worked day. Thresholds are per-policy,
 * not hardcoded, so different policies (e.g. a part-time employment
 * type) can define different expectations without a code change.
 */
function classifyByHours(workingMinutes: number, policy: ResolvedPolicy): ComputedAttendance {
  const hours = workingMinutes / 60;
  if (hours >= policy.fullDayThresholdHours) {
    return { statusCode: "PRESENT", workingMinutes, lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0, isHalfDay: false };
  }
  if (hours >= policy.halfDayThresholdHours) {
    return { statusCode: "HALF_DAY", workingMinutes, lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0, isHalfDay: true };
  }
  return { statusCode: "ABSENT", workingMinutes, lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0, isHalfDay: false };
}

export async function getStatusIdByCode(client: PgClient, statusCode: string): Promise<number> {
  const { rows } = await client.query(`select id from attendance_statuses where status_code = $1`, [statusCode]);
  if (rows.length === 0) {
    throw new Error(`Attendance status code '${statusCode}' not found — schema-attendance.sql's seed may not have run.`);
  }
  return rows[0].id;
}
