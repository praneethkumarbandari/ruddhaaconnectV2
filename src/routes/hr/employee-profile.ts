import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";

/**
 * All routes here are mounted at /api/hr/employees/:employeeId/... in
 * app.ts (mergeParams required so req.params.employeeId is visible).
 * Every sub-resource here is part of "Employee Profile" per the spec
 * and shares hr.employee.view/manage — bank + statutory details are
 * deliberately NOT here (see employee-sensitive.ts) because they're
 * gated by the stricter hr.employee.sensitive.* codes instead.
 */
const router = Router({ mergeParams: true });

// ------------------------------------------------------------
// ADDRESSES
// ------------------------------------------------------------
router.get("/addresses", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_addresses where employee_id = $1 order by address_type`, [req.params.employeeId]);
  return res.status(200).json(rows);
}));

router.put("/addresses/:type", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const addressType = req.params.type;
  if (!["current", "permanent"].includes(addressType)) {
    return res.status(400).json({ error: "address type must be 'current' or 'permanent'." });
  }
  const { line1, line2, city, state, pincode, country } = req.body ?? {};
  if (!line1) return res.status(400).json({ error: "line1 is required." });

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into employee_addresses (employee_id, address_type, line1, line2, city, state, pincode, country)
       values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'India'))
       on conflict (employee_id, address_type)
       do update set line1 = excluded.line1, line2 = excluded.line2, city = excluded.city,
         state = excluded.state, pincode = excluded.pincode, country = excluded.country, updated_at = now()
       returning *`,
      [employeeId, addressType, line1, line2 ?? null, city ?? null, state ?? null, pincode ?? null, country ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_addresses", recordId: employeeId, newValue: rows[0] });
    return rows[0];
  });
  return res.status(200).json(result);
}));

// ------------------------------------------------------------
// CONTACT DETAILS (1:1)
// ------------------------------------------------------------
router.get("/contact", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_contact_details where employee_id = $1`, [req.params.employeeId]);
  return res.status(200).json(rows[0] ?? null);
}));

router.put("/contact", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { personalEmail, personalPhone, alternatePhone } = req.body ?? {};

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into employee_contact_details (employee_id, personal_email, personal_phone, alternate_phone)
         values ($1,$2,$3,$4)
         on conflict (employee_id)
         do update set personal_email = excluded.personal_email, personal_phone = excluded.personal_phone,
           alternate_phone = excluded.alternate_phone, updated_at = now()
         returning *`,
        [employeeId, personalEmail ?? null, personalPhone ?? null, alternatePhone ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_contact_details", recordId: employeeId, newValue: rows[0] });
      return rows[0];
    });
    return res.status(200).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Personal email "${personalEmail}" is already recorded for another employee.` });
    }
    throw err;
  }
}));

// ------------------------------------------------------------
// EMERGENCY CONTACTS (one-to-many, at most one primary)
// ------------------------------------------------------------
router.get("/emergency-contacts", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_emergency_contacts where employee_id = $1 order by is_primary desc, id`, [req.params.employeeId]);
  return res.status(200).json(rows);
}));

router.post("/emergency-contacts", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { contactName, relationship, phoneNumber, isPrimary } = req.body ?? {};
  if (!contactName || !phoneNumber) return res.status(400).json({ error: "contactName and phoneNumber are required." });

  try {
    const result = await withTransaction(async (client) => {
      // If this one is being marked primary, demote any existing
      // primary first — the partial unique index would otherwise
      // reject the insert outright rather than let the caller "move"
      // primary status in one call.
      if (isPrimary) {
        await client.query(`update employee_emergency_contacts set is_primary = false where employee_id = $1 and is_primary = true`, [employeeId]);
      }
      const { rows } = await client.query(
        `insert into employee_emergency_contacts (employee_id, contact_name, relationship, phone_number, is_primary)
         values ($1,$2,$3,$4,$5) returning *`,
        [employeeId, contactName, relationship ?? null, phoneNumber, isPrimary ?? false],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "employee_emergency_contacts", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23503") return res.status(404).json({ error: "Employee not found." });
    throw err;
  }
}));

router.delete("/emergency-contacts/:contactId", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(`delete from employee_emergency_contacts where id = $1 and employee_id = $2 returning *`, [req.params.contactId, req.params.employeeId]);
    if (rows.length > 0) {
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_emergency_contacts", recordId: Number(req.params.contactId), oldValue: rows[0] });
    }
  });
  return res.status(200).json({ deleted: true });
}));

// ------------------------------------------------------------
// EDUCATION
// ------------------------------------------------------------
router.get("/education", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_education where employee_id = $1 order by year_of_passing desc nulls last`, [req.params.employeeId]);
  return res.status(200).json(rows);
}));

router.post("/education", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { qualification, institution, specialization, yearOfPassing, grade } = req.body ?? {};
  if (!qualification) return res.status(400).json({ error: "qualification is required." });

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into employee_education (employee_id, qualification, institution, specialization, year_of_passing, grade)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [employeeId, qualification, institution ?? null, specialization ?? null, yearOfPassing ?? null, grade ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "employee_education", recordId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
  return res.status(201).json(result);
}));

router.delete("/education/:recordId", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(`delete from employee_education where id = $1 and employee_id = $2 returning *`, [req.params.recordId, req.params.employeeId]);
    if (rows.length > 0) {
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_education", recordId: Number(req.params.recordId), oldValue: rows[0] });
    }
  });
  return res.status(200).json({ deleted: true });
}));

// ------------------------------------------------------------
// EXPERIENCE
// ------------------------------------------------------------
router.get("/experience", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_experience where employee_id = $1 order by from_date desc`, [req.params.employeeId]);
  return res.status(200).json(rows);
}));

router.post("/experience", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { companyName, designation, fromDate, toDate, description } = req.body ?? {};
  if (!companyName || !fromDate) return res.status(400).json({ error: "companyName and fromDate are required." });

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into employee_experience (employee_id, company_name, designation, from_date, to_date, description)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [employeeId, companyName, designation ?? null, fromDate, toDate ?? null, description ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "employee_experience", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23514") return res.status(400).json({ error: "toDate cannot be before fromDate." });
    throw err;
  }
}));

router.delete("/experience/:recordId", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(`delete from employee_experience where id = $1 and employee_id = $2 returning *`, [req.params.recordId, req.params.employeeId]);
    if (rows.length > 0) {
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_experience", recordId: Number(req.params.recordId), oldValue: rows[0] });
    }
  });
  return res.status(200).json({ deleted: true });
}));

// ------------------------------------------------------------
// SKILLS
// ------------------------------------------------------------
router.get("/skills", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_skills where employee_id = $1 order by skill_name`, [req.params.employeeId]);
  return res.status(200).json(rows);
}));

router.post("/skills", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { skillName, proficiencyLevel } = req.body ?? {};
  if (!skillName) return res.status(400).json({ error: "skillName is required." });

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into employee_skills (employee_id, skill_name, proficiency_level) values ($1,$2,$3) returning *`,
        [employeeId, skillName, proficiencyLevel ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "employee_skills", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: `Skill "${skillName}" is already recorded for this employee.` });
    throw err;
  }
}));

router.delete("/skills/:recordId", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(`delete from employee_skills where id = $1 and employee_id = $2 returning *`, [req.params.recordId, req.params.employeeId]);
    if (rows.length > 0) {
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_skills", recordId: Number(req.params.recordId), oldValue: rows[0] });
    }
  });
  return res.status(200).json({ deleted: true });
}));

// ------------------------------------------------------------
// CERTIFICATIONS
// ------------------------------------------------------------
router.get("/certifications", requirePermission("hr.employee.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from employee_certifications where employee_id = $1 order by issued_date desc nulls last`, [req.params.employeeId]);
  return res.status(200).json(rows);
}));

router.post("/certifications", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { certificationName, issuedBy, issuedDate, expiryDate, certificateNumber } = req.body ?? {};
  if (!certificationName) return res.status(400).json({ error: "certificationName is required." });

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into employee_certifications (employee_id, certification_name, issued_by, issued_date, expiry_date, certificate_number)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [employeeId, certificationName, issuedBy ?? null, issuedDate ?? null, expiryDate ?? null, certificateNumber ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "employee_certifications", recordId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
  return res.status(201).json(result);
}));

router.delete("/certifications/:recordId", requirePermission("hr.employee.manage"), asyncHandler(async (req: Request, res: Response) => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(`delete from employee_certifications where id = $1 and employee_id = $2 returning *`, [req.params.recordId, req.params.employeeId]);
    if (rows.length > 0) {
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_certifications", recordId: Number(req.params.recordId), oldValue: rows[0] });
    }
  });
  return res.status(200).json({ deleted: true });
}));

export default router;
