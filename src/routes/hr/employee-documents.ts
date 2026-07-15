import { Router, type Request, type Response } from "express";
import multer from "multer";
import { pool, withTransaction, query } from "../../db/pool.ts";
import { writeAudit } from "../../lib/audit.ts";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import { uploadFile, downloadFile } from "../../lib/google-drive.ts";

/** Mounted at /api/hr/employees/:employeeId/documents (mergeParams). */
const router = Router({ mergeParams: true });
const ALLOWED_DOCUMENT_EXTENSIONS = /\.(pdf|jpg|jpeg|png|webp)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB cap
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_DOCUMENT_EXTENSIONS.test(file.originalname)) {
      return cb(new Error("Only PDF or image files (jpg, png, webp) are accepted for employee documents."));
    }
    cb(null, true);
  },
});

router.get("/", requirePermission("hr.employee_document.view"), asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(
    `select ed.*, dt.document_type_code, dt.document_type_name
     from employee_documents ed
     join document_types dt on dt.id = ed.document_type_id
     where ed.employee_id = $1
     order by ed.uploaded_at desc`,
    [req.params.employeeId],
  );
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("hr.employee_document.manage"), upload.single("file"), asyncHandler(async (req: Request, res: Response) => {
  const employeeId = Number(req.params.employeeId);
  const { documentTypeId, documentNumber, issuedDate, expiryDate } = req.body ?? {};
  if (!documentTypeId) return res.status(400).json({ error: "documentTypeId is required." });

  // FIX: this used to only accept a typed-in "fileReference" text
  // field — no actual file was ever uploaded or stored anywhere. Now
  // accepts a real file (multipart, field name "file"), uploads it to
  // this tenant's Google Drive folder, and stores the resulting Drive
  // file id as fileReference — same column, now holding something
  // real instead of a manually-typed note.
  const file = (req as Request & { file?: Express.Multer.File }).file;
  let driveFileId: string | null = null;
  if (file) {
    if (!req.user?.schemaName) {
      return res.status(500).json({ error: "No company/schema context available for this upload." });
    }
    const result = await uploadFile({
      schemaName: req.user.schemaName,
      fileName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
    driveFileId = result.driveFileId;
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows: docType } = await client.query(`select 1 from document_types where id = $1`, [documentTypeId]);
      if (docType.length === 0) throw new DocumentTypeNotFoundError(documentTypeId);

      const { rows } = await client.query(
        `insert into employee_documents (employee_id, document_type_id, document_number, file_reference, file_name, mime_type, issued_date, expiry_date)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [employeeId, documentTypeId, documentNumber ?? null, driveFileId, file?.originalname ?? null, file?.mimetype ?? null, issuedDate ?? null, expiryDate ?? null],
      );
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "employee_documents", recordId: rows[0].id, newValue: rows[0] });
      return rows[0];
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof DocumentTypeNotFoundError) return res.status(400).json({ error: err.message });
    if ((err as { code?: string }).code === "23503") return res.status(404).json({ error: "Employee not found." });
    throw err;
  }
}));

router.get("/:documentId/download", requirePermission("hr.employee_document.view"), asyncHandler(async (req: Request, res: Response) => {
  // Tenant check happens here, via our own DB row, BEFORE ever asking
  // Drive for the file — a Drive file id alone proves nothing about
  // which tenant is allowed to see it. tenantContextMiddleware's RLS
  // already scopes this query to the caller's tenant, so a row from
  // another tenant simply won't be found here.
  const { rows } = await query(
    `select file_reference, file_name, mime_type from employee_documents where id = $1 and employee_id = $2`,
    [req.params.documentId, req.params.employeeId],
  );
  if (rows.length === 0 || !rows[0].file_reference) {
    return res.status(404).json({ error: "Document not found or has no uploaded file." });
  }
  const { stream, mimeType } = await downloadFile(rows[0].file_reference);
  res.setHeader("Content-Type", rows[0].mime_type || mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${rows[0].file_name || "document"}"`);
  stream.pipe(res);
}));

router.post("/:documentId/verify", requirePermission("hr.employee_document.manage"), asyncHandler(async (req: Request, res: Response) => {
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from employee_documents where id = $1 and employee_id = $2`, [req.params.documentId, req.params.employeeId]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(`update employee_documents set is_verified = true where id = $1 returning *`, [req.params.documentId]);
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_documents", recordId: Number(req.params.documentId), oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
  if (!result) return res.status(404).json({ error: "Document not found." });
  return res.status(200).json(result);
}));

router.delete("/:documentId", requirePermission("hr.employee_document.manage"), asyncHandler(async (req: Request, res: Response) => {
  await withTransaction(async (client) => {
    const { rows } = await client.query(`delete from employee_documents where id = $1 and employee_id = $2 returning *`, [req.params.documentId, req.params.employeeId]);
    if (rows.length > 0) {
      await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "employee_documents", recordId: Number(req.params.documentId), oldValue: rows[0] });
    }
  });
  return res.status(200).json({ deleted: true });
}));

class DocumentTypeNotFoundError extends Error {
  constructor(id: number) {
    super(`documentTypeId ${id} does not reference an existing document type.`);
    this.name = "DocumentTypeNotFoundError";
  }
}

export default router;
