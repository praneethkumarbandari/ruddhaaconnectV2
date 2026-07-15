/**
 * HR MODULE — MILESTONE 3: ATTENDANCE ENGINE — REGRESSION SUITE
 * ==========================================================
 *
 * Run with:
 *   npx tsx test/attendance-regression.ts
 *
 * Same technique as every prior HR regression suite: drives the real
 * Netlify Function `handler()` directly (no network/Netlify infra
 * needed), including a real multipart file upload for the import
 * engine (same binary-body-reconstruction technique proven in
 * test/netlify-function-adapter.ts's bank-import upload test).
 *
 * Requires schema.sql through schema-attendance.sql all applied.
 */

import bcrypt from "bcryptjs";
import { pool } from "../src/db/pool.ts";
import { handler } from "../netlify/functions/api.ts";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail: msg });
    console.log(`FAIL  ${name}`);
    console.log(`      -> ${msg}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function parseQuery(path: string): Record<string, string> | null {
  const qIndex = path.indexOf("?");
  if (qIndex === -1) return null;
  const params = new URLSearchParams(path.slice(qIndex + 1));
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return Object.keys(out).length ? out : null;
}

function buildEvent(opts: { method: string; path: string; headers?: Record<string, string>; body?: string | Buffer | null }) {
  return {
    httpMethod: opts.method,
    // FIX (test harness, not product code): a real Netlify/API Gateway
    // event never puts the query string inside `path` -- it always
    // arrives split out in `queryStringParameters`. Splitting it out
    // here the same way means callers can still write a natural
    // '/foo?bar=baz' path and this harness models real event shape.
    path: opts.path.split("?")[0],
    headers: opts.headers ?? {},
    multiValueHeaders: {},
    queryStringParameters: parseQuery(opts.path),
    multiValueQueryStringParameters: null,
    body: opts.body == null ? null : (Buffer.isBuffer(opts.body) ? opts.body.toString("base64") : opts.body),
    isBase64Encoded: Buffer.isBuffer(opts.body),
    requestContext: { requestId: "att-test-" + Date.now(), identity: { sourceIp: "127.0.0.1" } },
  };
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const event = buildEvent({ method, path: `/.netlify/functions/api${path}`, headers, body: body === undefined ? null : JSON.stringify(body) });
  const resp: any = await handler(event, {});
  return { status: resp.statusCode, body: resp.body ? JSON.parse(resp.body) : null };
}

async function uploadCsv(path: string, token: string, csvContent: string, filename = "biometric.csv") {
  const boundary = "----AttendanceTestBoundary";
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${csvContent}\r\n` +
    `--${boundary}--\r\n`;
  const event = buildEvent({
    method: "POST",
    path: `/.netlify/functions/api${path}`,
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.from(multipartBody, "utf8"),
  });
  const resp: any = await handler(event, {});
  return { status: resp.statusCode, body: resp.body ? JSON.parse(resp.body) : null };
}

const RUN = Date.now();
const BOOTSTRAP_PASSWORD = "att-test-password-123";

async function bootstrapEmployee(label: string, roleCode: string): Promise<{ id: number; token: string }> {
  const username = `att_test_${label}_${RUN}`;
  const hash = await bcrypt.hash(BOOTSTRAP_PASSWORD, 4);
  const { rows } = await pool.query(
    `insert into employees (username, employee_name, password_hash) values ($1, $2, $3) returning id`,
    [username, `Attendance Test ${label} ${RUN}`, hash],
  );
  const { rows: role } = await pool.query(`select id from roles where role_code = $1`, [roleCode]);
  assert(role.length === 1, `role ${roleCode} not found`);
  await pool.query(`insert into user_roles (employee_id, role_id) values ($1, $2)`, [rows[0].id, role[0].id]);
  const { status, body } = await call("POST", "/auth/login", null, { username, password: BOOTSTRAP_PASSWORD });
  assert(status === 200, `bootstrap login for ${label} failed: ${JSON.stringify(body)}`);
  return { id: rows[0].id, token: body.token };
}

async function main() {
  const hrAdmin = await bootstrapEmployee("hradmin", "HR_ADMIN");
  const noRole = await bootstrapEmployee("norole", "EMPLOYEE");

  // ------------------------------------------------------------
  // Setup: department, shifts, policy, two real HR employees
  // (manager + subordinate) via the actual Milestone 2 API, so the
  // reporting-manager chain is real and the correction-approval
  // workflow can be tested against it.
  // ------------------------------------------------------------
  const { rows: deptRows } = await pool.query(`insert into departments (department_code, department_name) values ($1,'Attendance Test Dept') returning id`, [`ATTDEPT_${RUN}`]);
  const departmentId = Number(deptRows[0].id);

  let managerEmployeeId = 0;
  let managerToken = "";
  await check("create manager employee via HR API", async () => {
    const { status, body } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `ATT_MGR_${RUN}`, employeeName: "Attendance Manager", departmentId, joiningDate: "2024-01-01",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    managerEmployeeId = body.employee_id;
    const login = await call("POST", "/auth/login", null, { username: body.username, password: body.temporaryPassword });
    assert(login.status === 200, "manager login failed");
    managerToken = login.body.token;
  });

  let empEmployeeId = 0;
  let empToken = "";
  await check("create subordinate employee reporting to the manager", async () => {
    const { status, body } = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `ATT_EMP_${RUN}`, employeeName: "Attendance Employee", departmentId,
      reportingManagerId: managerEmployeeId, joiningDate: "2024-01-01",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    empEmployeeId = body.employee_id;
    const login = await call("POST", "/auth/login", null, { username: body.username, password: body.temporaryPassword });
    assert(login.status === 200, "employee login failed");
    empToken = login.body.token;
  });

  let policyId = 0;
  await check("create an attendance policy with overtime enabled", async () => {
    const { status, body } = await call("POST", "/attendance/policies", hrAdmin.token, {
      policyCode: `POL_${RUN}`, policyName: "Test Policy", graceMinutes: 10,
      halfDayThresholdHours: 4, fullDayThresholdHours: 8, overtimeEnabled: true, overtimeThresholdMinutes: 0, minOvertimeMinutes: 15,
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    policyId = body.id;
  });

  await check("policy with half >= full threshold is rejected (422)", async () => {
    const { status } = await call("POST", "/attendance/policies", hrAdmin.token, { policyCode: `POL_BAD_${RUN}`, policyName: "Bad", halfDayThresholdHours: 8, fullDayThresholdHours: 8 });
    assert(status === 422, `expected 422, got ${status}`);
  });

  let dayShiftId = 0;
  let nightShiftId = 0;
  await check("create a day shift and a night (cross-day) shift, both using the test policy", async () => {
    const day = await call("POST", "/hr/shifts", hrAdmin.token, { shiftCode: `DAYSHIFT_${RUN}`, shiftName: "Day", startTime: "09:00", endTime: "18:00", breakMinutes: 60 });
    assert(day.status === 201, `day shift: expected 201, got ${day.status}`);
    dayShiftId = day.body.id;
    const night = await call("POST", "/hr/shifts", hrAdmin.token, { shiftCode: `NIGHTSHIFT_${RUN}`, shiftName: "Night", startTime: "22:00", endTime: "06:00", breakMinutes: 30 });
    assert(night.status === 201, `night shift: expected 201, got ${night.status}`);
    nightShiftId = night.body.id;

    // Attach the test policy directly (no dedicated endpoint for this
    // additive column — a direct update is fine for test setup).
    await pool.query(`update shifts set attendance_policy_id = $1 where id in ($2, $3)`, [policyId, dayShiftId, nightShiftId]);
  });

  await check("assign the day shift to the manager and the night shift to the employee", async () => {
    const a = await call("POST", "/attendance/shift-assignments", hrAdmin.token, { employeeId: managerEmployeeId, shiftId: dayShiftId, effectiveFrom: "2024-01-01" });
    assert(a.status === 201, `expected 201, got ${a.status}: ${JSON.stringify(a.body)}`);
    const b = await call("POST", "/attendance/shift-assignments", hrAdmin.token, { employeeId: empEmployeeId, shiftId: nightShiftId, effectiveFrom: "2024-01-01" });
    assert(b.status === 201, `expected 201, got ${b.status}: ${JSON.stringify(b.body)}`);
  });

  await check("overlapping shift assignment for the same employee is rejected", async () => {
    const { status } = await call("POST", "/attendance/shift-assignments", hrAdmin.token, { employeeId: managerEmployeeId, shiftId: nightShiftId, effectiveFrom: "2024-06-01" });
    assert(status === 409, `expected 409, got ${status}`);
  });

  // ------------------------------------------------------------
  // PERMISSION ENFORCEMENT
  // ------------------------------------------------------------
  await check("role-less employee cannot view attendance records (403)", async () => {
    const { status } = await call("GET", "/attendance/records", noRole.token);
    assert(status === 403, `expected 403, got ${status}`);
  });

  await check("unauthenticated request to attendance import is rejected (401)", async () => {
    const { status } = await call("GET", "/attendance/import/history", null);
    assert(status === 401, `expected 401, got ${status}`);
  });

  // ------------------------------------------------------------
  // BIOMETRIC IMPORT — preview, validation, commit, duplicate detection
  // ------------------------------------------------------------
  const importDate = "2024-02-05";
  let importBatchId = 0;
  await check("preview a valid CSV import", async () => {
    const csv = `Emp Code,Date,In Time,Out Time\n${`ATT_MGR_${RUN}`},${importDate},09:05,18:10\n`;
    const { status, body } = await uploadCsv("/attendance/import/preview", hrAdmin.token, csv);
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert(body.batch.rows_valid === 1, `expected 1 valid row, got ${body.batch.rows_valid}`);
    importBatchId = body.batch.id;
  });

  await check("preview correctly rejects an unknown employee code", async () => {
    const csv = `Emp Code,Date,In Time,Out Time\nNO_SUCH_CODE_${RUN},${importDate},09:00,18:00\n`;
    const { status, body } = await uploadCsv("/attendance/import/preview", hrAdmin.token, csv);
    assert(status === 201, `expected 201, got ${status}`);
    assert(body.batch.rows_rejected === 1, `expected 1 rejected row, got ${JSON.stringify(body.batch)}`);
    assert(body.preview[0].rejectionReason.includes("Unknown employee code"), `wrong rejection reason: ${body.preview[0].rejectionReason}`);
  });

  await check("preview correctly rejects an invalid date", async () => {
    const csv = `Emp Code,Date,In Time,Out Time\n${`ATT_MGR_${RUN}`},not-a-date,09:00,18:00\n`;
    const { status, body } = await uploadCsv("/attendance/import/preview", hrAdmin.token, csv);
    assert(status === 201, `expected 201, got ${status}`);
    assert(body.batch.rows_rejected === 1, `expected 1 rejected row for bad date`);
  });

  await check("commit the valid batch creates a real attendance record with correct late-minute calculation", async () => {
    const { status, body } = await call("POST", `/attendance/import/commit/${importBatchId}`, hrAdmin.token);
    assert(status === 200 && body.status === "committed", `expected committed batch, got ${status}: ${JSON.stringify(body)}`);

    const { rows } = await pool.query(
      `select ar.*, ast.status_code from attendance_records ar join attendance_statuses ast on ast.id = ar.status_id where ar.employee_id = $1 and ar.attendance_date = $2`,
      [managerEmployeeId, importDate],
    );
    assert(rows.length === 1, "expected exactly one committed attendance record");
    assert(rows[0].status_code === "PRESENT", `expected PRESENT, got ${rows[0].status_code}`);
    // Shift 09:00, grace 10 min -> punch at 09:05 is within grace, so late_minutes should be 0.
    assert(Number(rows[0].late_minutes) === 0, `expected 0 late minutes (within grace), got ${rows[0].late_minutes}`);
  });

  let mergeBatchId = 0;
  const mergeDate = "2024-02-06";
  await check("multiple punch rows for the same employee+date are MERGED (first-in/last-out), not rejected as duplicates", async () => {
    // Simulates a raw punch-log export: clock-in, lunch-out, lunch-in,
    // clock-out as four separate rows for the same employee+date.
    const csv =
      `Emp Code,Date,In Time,Out Time\n` +
      `${`ATT_MGR_${RUN}`},${mergeDate},09:00,\n` +
      `${`ATT_MGR_${RUN}`},${mergeDate},,13:00\n` +
      `${`ATT_MGR_${RUN}`},${mergeDate},13:30,\n` +
      `${`ATT_MGR_${RUN}`},${mergeDate},,18:00\n`;
    const { status, body } = await uploadCsv("/attendance/import/preview", hrAdmin.token, csv);
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert(body.batch.rows_valid === 1, `expected exactly 1 primary (merged) row, got ${JSON.stringify(body.batch)}`);
    mergeBatchId = body.batch.id;

    const { status: rowsStatus, body: rowsBody } = await call("GET", `/attendance/import/${mergeBatchId}/rows`, hrAdmin.token);
    assert(rowsStatus === 200, "failed to fetch batch rows");
    const mergedRows = rowsBody.filter((r: any) => r.status === "merged");
    assert(mergedRows.length === 3, `expected 3 rows merged into the primary, got ${mergedRows.length}`);
  });

  await check("committing the merged batch produces one record with the correctly aggregated first-in/last-out", async () => {
    const { status } = await call("POST", `/attendance/import/commit/${mergeBatchId}`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}`);
    const { rows } = await pool.query(`select in_timestamp, out_timestamp from attendance_records where employee_id = $1 and attendance_date = $2`, [managerEmployeeId, mergeDate]);
    assert(rows.length === 1, "expected exactly one record for the merged day");
    const inHour = new Date(rows[0].in_timestamp).getUTCHours();
    const outHour = new Date(rows[0].out_timestamp).getUTCHours();
    assert(inHour === 9, `expected first-in at hour 9, got ${inHour}`);
    assert(outHour === 18, `expected last-out at hour 18, got ${outHour}`);
  });

  await check("re-previewing the same employee+date now correctly flags it as a duplicate", async () => {
    const csv = `Emp Code,Date,In Time,Out Time\n${`ATT_MGR_${RUN}`},${importDate},09:00,18:00\n`;
    const { status, body } = await uploadCsv("/attendance/import/preview", hrAdmin.token, csv);
    assert(status === 201, `expected 201, got ${status}`);
    assert(body.batch.rows_duplicate === 1, `expected 1 duplicate row, got ${JSON.stringify(body.batch)}`);
  });

  await check("import error log endpoint returns the rejected rows", async () => {
    const csv = `Emp Code,Date,In Time,Out Time\nNO_SUCH_CODE_2_${RUN},2024-02-07,09:00,18:00\n`;
    const { body: previewBody } = await uploadCsv("/attendance/import/preview", hrAdmin.token, csv);
    const { status, body } = await call("GET", `/attendance/import/${previewBody.batch.id}/errors`, hrAdmin.token);
    assert(status === 200 && Array.isArray(body) && body.length === 1, `expected 1 error row, got ${status}: ${JSON.stringify(body)}`);
  });

  // ------------------------------------------------------------
  // DOMAIN REVIEW: PER-ROW-RESILIENT COMMIT
  // A single problem row must not roll back the rest of an otherwise
  // good batch, and a partially-failed commit must be safely retryable.
  // ------------------------------------------------------------
  let resilienceBatchId = 0;
  const goodDate = "2024-02-08";
  const lockedDate = "2024-02-09";
  await check("lock one of two dates before committing a batch that covers both", async () => {
    const lockResp = await call("POST", "/attendance/locks", hrAdmin.token, { lockType: "daily", periodDate: lockedDate });
    assert(lockResp.status === 201, "setup: failed to lock date");

    const csv =
      `Emp Code,Date,In Time,Out Time\n` +
      `${`ATT_MGR_${RUN}`},${goodDate},09:00,18:00\n` +
      `${`ATT_EMP_${RUN}`},${lockedDate},22:00,\n`; // employee's night shift, date already locked
    const { status, body } = await uploadCsv("/attendance/import/preview", hrAdmin.token, csv);
    assert(status === 201 && body.batch.rows_valid === 2, `expected 2 valid rows at preview time (locking isn't checked until commit), got ${JSON.stringify(body.batch)}`);
    resilienceBatchId = body.batch.id;
  });

  await check("committing: the non-locked row succeeds even though the locked row fails", async () => {
    const { status, body } = await call("POST", `/attendance/import/commit/${resilienceBatchId}`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(Number(body.rows_committed) === 1, `expected exactly 1 row committed out of 2, got ${body.rows_committed}`);

    const { rows: goodRecord } = await pool.query(`select 1 from attendance_records where employee_id = $1 and attendance_date = $2`, [managerEmployeeId, goodDate]);
    assert(goodRecord.length === 1, "the non-locked row's record should exist despite the other row failing");

    const { rows: failedRow } = await pool.query(`select status from attendance_import_rows where batch_id = $1 and attendance_date = $2`, [resilienceBatchId, lockedDate]);
    assert(failedRow[0].status === "commit_failed", `expected the locked row to be marked commit_failed, got ${failedRow[0].status}`);
  });

  await check("retrying commit after unlocking succeeds for the previously-failed row", async () => {
    const { rows: lockRows } = await pool.query(`select id from attendance_locks where lock_type = 'daily' and period_date = $1 and is_active = true`, [lockedDate]);
    await call("POST", `/attendance/locks/${lockRows[0].id}/unlock`, hrAdmin.token);

    const { status, body } = await call("POST", `/attendance/import/commit/${resilienceBatchId}`, hrAdmin.token);
    assert(status === 200 && Number(body.rows_committed) === 2, `expected retry to bring rows_committed to 2, got ${status}: ${JSON.stringify(body)}`);

    const { rows: nowCommitted } = await pool.query(`select 1 from attendance_records where employee_id = $1 and attendance_date = $2`, [empEmployeeId, lockedDate]);
    assert(nowCommitted.length === 1, "the previously-failed row should now be committed");
  });

  await check("re-committing a fully-committed batch is rejected (already committed)", async () => {
    const { status } = await call("POST", `/attendance/import/commit/${resilienceBatchId}`, hrAdmin.token);
    assert(status === 409, `expected 409, got ${status}`);
  });

  // ------------------------------------------------------------
  // CROSS-DAY (NIGHT) SHIFT
  // ------------------------------------------------------------
  await check("cross-day night shift computes working hours correctly across midnight", async () => {
    const nightDate = "2024-02-10";
    const { status, body } = await call("PUT", "/attendance/records/manual", hrAdmin.token, {
      employeeId: empEmployeeId,
      attendanceDate: nightDate,
      inTimestamp: `${nightDate}T22:10:00Z`,
      outTimestamp: `2024-02-11T06:05:00Z`,
    });
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    // Shift 22:00-06:00 (8h), break 30 min, punched 10 min late in
    // and 5 min early out, both within the 10-min grace -> expect
    // full PRESENT status and roughly 7h25m (445 min) worked.
    assert(body.status_id, "no status_id returned");
    const { rows } = await pool.query(`select ast.status_code, ar.working_minutes, ar.late_minutes, ar.early_exit_minutes from attendance_records ar join attendance_statuses ast on ast.id = ar.status_id where ar.id = $1`, [body.id]);
    assert(rows[0].status_code === "PRESENT", `expected PRESENT, got ${rows[0].status_code}`);
    assert(Number(rows[0].working_minutes) > 400 && Number(rows[0].working_minutes) < 460, `expected ~445 working minutes, got ${rows[0].working_minutes}`);
  });

  // ------------------------------------------------------------
  // DOMAIN REVIEW: MISSING PUNCH -> INCOMPLETE, NOT ABSENT
  // ------------------------------------------------------------
  await check("a punch with only IN (no OUT) is classified INCOMPLETE, not ABSENT", async () => {
    const oneSidedDate = "2024-02-13";
    const { status, body } = await call("PUT", "/attendance/records/manual", hrAdmin.token, {
      employeeId: managerEmployeeId, attendanceDate: oneSidedDate, inTimestamp: `${oneSidedDate}T09:00:00Z`, outTimestamp: null,
    });
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    const { rows } = await pool.query(`select ast.status_code, ar.working_minutes from attendance_records ar join attendance_statuses ast on ast.id = ar.status_id where ar.id = $1`, [body.id]);
    assert(rows[0].status_code === "INCOMPLETE", `expected INCOMPLETE, got ${rows[0].status_code}`);
    assert(rows[0].working_minutes === null, `expected null working_minutes for an incomplete punch, got ${rows[0].working_minutes}`);
  });

  await check("a day with genuinely no punch at all still resolves normally (e.g. ABSENT), not INCOMPLETE", async () => {
    const noPunchDate = "2024-02-14";
    const { status, body } = await call("PUT", "/attendance/records/manual", hrAdmin.token, {
      employeeId: managerEmployeeId, attendanceDate: noPunchDate, inTimestamp: null, outTimestamp: null,
    });
    assert(status === 200, `expected 200, got ${status}`);
    const { rows } = await pool.query(`select ast.status_code from attendance_records ar join attendance_statuses ast on ast.id = ar.status_id where ar.id = $1`, [body.id]);
    assert(rows[0].status_code === "ABSENT", `expected ABSENT for a genuinely punch-less working day, got ${rows[0].status_code}`);
  });

  // ------------------------------------------------------------
  // DOMAIN REVIEW: EMPLOYMENT-DATE BOUNDARY VALIDATION
  // ------------------------------------------------------------
  await check("attendance before an employee's joining date is rejected", async () => {
    const { status, body } = await call("PUT", "/attendance/records/manual", hrAdmin.token, {
      employeeId: managerEmployeeId, attendanceDate: "2020-01-01", inTimestamp: "2020-01-01T09:00:00Z", outTimestamp: "2020-01-01T18:00:00Z",
    });
    assert(status === 422, `expected 422, got ${status}: ${JSON.stringify(body)}`);
  });

  await check("attendance after an employee's exit date is rejected", async () => {
    // Create a throwaway employee specifically so exiting them doesn't
    // interfere with the rest of the suite's use of managerEmployeeId/empEmployeeId.
    const created = await call("POST", "/hr/employees", hrAdmin.token, {
      employeeCode: `ATT_EXITED_${RUN}`, employeeName: "Exited Employee", joiningDate: "2024-01-01",
    });
    const exitedId = created.body.employee_id;
    const exitResp = await call("PATCH", `/hr/employees/${exitedId}`, hrAdmin.token, { status: "exited", exitDate: "2024-03-01" });
    assert(exitResp.status === 200, "setup: failed to exit the test employee");

    const { status, body } = await call("PUT", "/attendance/records/manual", hrAdmin.token, {
      employeeId: exitedId, attendanceDate: "2024-03-15", inTimestamp: "2024-03-15T09:00:00Z", outTimestamp: "2024-03-15T18:00:00Z",
    });
    assert(status === 422, `expected 422, got ${status}: ${JSON.stringify(body)}`);
  });

  // ------------------------------------------------------------
  // DOMAIN REVIEW: DEPARTMENT/BRANCH SNAPSHOT ON ATTENDANCE RECORDS
  // ------------------------------------------------------------
  await check("a committed attendance record snapshots the employee's department at write time", async () => {
    const { rows } = await pool.query(`select department_id from attendance_records where employee_id = $1 and attendance_date = $2`, [managerEmployeeId, importDate]);
    assert(rows.length === 1 && Number(rows[0].department_id) === departmentId, `expected department_id ${departmentId} snapshotted, got ${JSON.stringify(rows[0])}`);
  });

  // ------------------------------------------------------------
  // OVERTIME
  // ------------------------------------------------------------
  await check("overtime is calculated when working hours exceed the shift plus threshold", async () => {
    const otDate = "2024-02-12";
    const { status, body } = await call("PUT", "/attendance/records/manual", hrAdmin.token, {
      employeeId: managerEmployeeId,
      attendanceDate: otDate,
      inTimestamp: `${otDate}T09:00:00Z`,
      outTimestamp: `${otDate}T20:00:00Z`, // 11h in, 1h break -> 10h worked vs 8h shift -> 2h (120 min) overtime
    });
    assert(status === 200, `expected 200, got ${status}`);
    assert(Number(body.overtime_minutes) >= 100, `expected significant overtime, got ${body.overtime_minutes}`);
  });

  // ------------------------------------------------------------
  // ATTENDANCE CORRECTIONS — full approval workflow
  // ------------------------------------------------------------
  const correctionDate = "2024-02-15";
  await check("seed a record to be corrected", async () => {
    const { status } = await call("PUT", "/attendance/records/manual", hrAdmin.token, {
      employeeId: empEmployeeId, attendanceDate: correctionDate, inTimestamp: `${correctionDate}T10:00:00Z`, outTimestamp: `${correctionDate}T18:00:00Z`,
    });
    assert(status === 200, "setup failed");
  });

  let correctionId = 0;
  await check("employee can request a correction for their own attendance", async () => {
    const { status, body } = await call("POST", "/attendance/corrections", empToken, {
      attendanceDate: correctionDate,
      requestedInTimestamp: `${correctionDate}T09:00:00Z`,
      requestedOutTimestamp: `${correctionDate}T18:00:00Z`,
      reason: "Forgot to punch in on time, actual arrival was 9am.",
    });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert(body.status === "pending" && body.current_level_order === 1, "unexpected initial state");
    correctionId = body.id;
  });

  await check("a manager who is NOT the requester's reporting manager cannot approve", async () => {
    const { status } = await call("POST", `/attendance/corrections/${correctionId}/approve`, hrAdmin.token);
    // hrAdmin holds attendance.correction.approve (coarse gate passes)
    // but is not the resolved reporting manager for empEmployeeId, so
    // the fine-grained entitlement check must reject this.
    assert(status === 403, `expected 403 (not entitled), got ${status}`);
  });

  await check("the actual reporting manager can approve level 1, advancing to level 2 (HR)", async () => {
    const { status, body } = await call("POST", `/attendance/corrections/${correctionId}/approve`, managerToken);
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(body.status === "pending" && body.current_level_order === 2, `expected pending at level 2, got ${JSON.stringify(body)}`);
  });

  await check("the manager (already used at level 1) cannot approve again at level 2 (wrong entitlement)", async () => {
    const { status } = await call("POST", `/attendance/corrections/${correctionId}/approve`, managerToken);
    assert(status === 403, `expected 403, got ${status}`);
  });

  await check("HR_ADMIN approves the final level, applying the correction to attendance_records", async () => {
    const { status, body } = await call("POST", `/attendance/corrections/${correctionId}/approve`, hrAdmin.token);
    assert(status === 200 && body.status === "applied", `expected applied, got ${status}: ${JSON.stringify(body)}`);

    const { rows } = await pool.query(`select source, in_timestamp from attendance_records where employee_id = $1 and attendance_date = $2`, [empEmployeeId, correctionDate]);
    assert(rows[0].source === "correction", `expected source='correction', got ${rows[0].source}`);
  });

  await check("acting on an already-applied (non-pending) request is rejected", async () => {
    const { status } = await call("POST", `/attendance/corrections/${correctionId}/approve`, hrAdmin.token);
    assert(status === 422, `expected 422, got ${status}`);
  });

  let rejectedCorrectionId = 0;
  await check("a correction request can be rejected", async () => {
    const created = await call("POST", "/attendance/corrections", empToken, {
      attendanceDate: "2024-02-16", requestedInTimestamp: `2024-02-16T09:00:00Z`, reason: "Test rejection flow",
    });
    rejectedCorrectionId = created.body.id;
    const { status, body } = await call("POST", `/attendance/corrections/${rejectedCorrectionId}/reject`, managerToken, { decisionNotes: "Not supported by biometric log." });
    assert(status === 200 && body.status === "rejected", `expected rejected, got ${status}: ${JSON.stringify(body)}`);
  });

  // ------------------------------------------------------------
  // LOCKING
  // ------------------------------------------------------------
  const lockDate = "2024-02-20";
  let lockId = 0;
  await check("seed then lock a date", async () => {
    await call("PUT", "/attendance/records/manual", hrAdmin.token, { employeeId: managerEmployeeId, attendanceDate: lockDate, inTimestamp: `${lockDate}T09:00:00Z`, outTimestamp: `${lockDate}T18:00:00Z` });
    const { status, body } = await call("POST", "/attendance/locks", hrAdmin.token, { lockType: "daily", periodDate: lockDate });
    assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    lockId = body.id;
  });

  await check("manual entry on a locked date is rejected (409)", async () => {
    const { status } = await call("PUT", "/attendance/records/manual", hrAdmin.token, { employeeId: managerEmployeeId, attendanceDate: lockDate, inTimestamp: `${lockDate}T09:00:00Z`, outTimestamp: `${lockDate}T19:00:00Z` });
    assert(status === 409, `expected 409, got ${status}`);
  });

  await check("unlocking allows edits again", async () => {
    const unlock = await call("POST", `/attendance/locks/${lockId}/unlock`, hrAdmin.token);
    assert(unlock.status === 200 && unlock.body.is_active === false, `expected unlocked, got ${JSON.stringify(unlock.body)}`);
    const { status } = await call("PUT", "/attendance/records/manual", hrAdmin.token, { employeeId: managerEmployeeId, attendanceDate: lockDate, inTimestamp: `${lockDate}T09:00:00Z`, outTimestamp: `${lockDate}T19:00:00Z` });
    assert(status === 200, `expected 200 after unlock, got ${status}`);
  });

  // ------------------------------------------------------------
  // SELF-SERVICE + REPORTS
  // ------------------------------------------------------------
  await check("employee can view their own attendance via /my without any attendance.* permission", async () => {
    const { status, body } = await call("GET", "/attendance/records/my", empToken);
    assert(status === 200 && Array.isArray(body.rows), `expected 200 with rows array, got ${status}`);
  });

  await check("attendance summary report returns aggregated figures for the manager", async () => {
    const { status, body } = await call("GET", `/attendance/reports/summary?employeeId=${managerEmployeeId}&dateFrom=2024-02-01&dateTo=2024-02-28`, hrAdmin.token);
    assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert(Number(body.present_days) >= 1, `expected at least 1 present day, got ${JSON.stringify(body)}`);
  });

  // ------------------------------------------------------------
  // BACKWARD COMPATIBILITY
  // ------------------------------------------------------------
  await check("Milestone 1/2 HR endpoints remain unaffected", async () => {
    const a = await call("GET", "/hr/departments", hrAdmin.token);
    assert(a.status === 200, `departments: expected 200, got ${a.status}`);
    const b = await call("GET", "/hr/employees", hrAdmin.token);
    assert(b.status === 200, `employees: expected 200, got ${b.status}`);
  });

  await check("legacy accounting routes remain unaffected by attendance.* permission gating", async () => {
    const { status } = await call("GET", "/chart-of-accounts", noRole.token);
    assert(status === 200, `expected 200 (unchanged legacy behavior), got ${status}`);
  });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  await pool.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
