import { Router, type Request, type Response } from "express";
import multer from "multer";
import { asyncHandler } from "../../lib/async-handler.ts";
import { requirePermission } from "../../middleware/permission.ts";
import {
  parseFile,
} from "../../lib/bank-import.ts";
import {
  autoDetectMapping,
  missingRequiredFields,
  previewAttendanceImport,
  commitAttendanceImport,
  rollbackAttendanceImport,
  getBatch,
  listBatches,
  getBatchRows,
  saveMappingTemplate,
  listMappingTemplates,
  EmptyAttendanceFileError,
  AttendanceMappingIncompleteError,
  AttendanceBatchNotFoundError,
  BatchAlreadyCommittedError,
  BatchNotCommittedError,
  type MappableField,
} from "../../lib/attendance-import.ts";
import { AttendanceLockedError } from "../../lib/attendance-locks.ts";
import { AttendanceOutsideEmploymentError } from "../../lib/attendance.ts";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function mapAttendanceImportError(err: unknown, res: Response): boolean {
  if (err instanceof EmptyAttendanceFileError || err instanceof AttendanceMappingIncompleteError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof AttendanceBatchNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  if (err instanceof BatchAlreadyCommittedError || err instanceof BatchNotCommittedError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof AttendanceLockedError) {
    // Thrown from inside commitAttendanceImport via
    // upsertAttendanceRecord() if any row's date is locked — a
    // realistic case (e.g. importing a file that includes a date
    // that's already been locked and finalized since the file was
    // exported), not a hypothetical this handler can skip.
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof AttendanceOutsideEmploymentError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

/**
 * Upload + preview in one step: parses the file, auto-detects (or
 * accepts an explicit) column mapping, validates and resolves every
 * row, and persists a batch in 'previewed' status — "Preview Before
 * Import" per the spec. Nothing is written to attendance_records
 * until a separate commit call.
 */
router.post("/preview", requirePermission("attendance.import.manage"), upload.single("file"), asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (expected multipart field 'file')." });

  let mapping: Partial<Record<MappableField, string>> | undefined;
  if (req.body?.mapping) {
    try { mapping = JSON.parse(req.body.mapping); } catch { return res.status(400).json({ error: "mapping must be valid JSON." }); }
  }

  try {
    const parsed = await parseFile(req.file.buffer, req.file.originalname);
    const resolvedMapping = mapping ?? autoDetectMapping(parsed.headers);
    const missing = missingRequiredFields(resolvedMapping);
    if (missing.length > 0) {
      // Distinct from AttendanceMappingIncompleteError's 400 thrown
      // deeper in the pipeline: here we return the parsed headers too,
      // so the import wizard can render a column-mapping UI instead of
      // just an error message.
      return res.status(422).json({
        error: `Column mapping is incomplete — missing: ${missing.join(", ")}.`,
        headers: parsed.headers,
        detectedMapping: resolvedMapping,
      });
    }

    let mappingTemplateId: number | null = null;
    if (req.body?.saveAsTemplateName) {
      const template = await saveMappingTemplate(req.body.saveAsTemplateName, resolvedMapping, req.user?.userId ?? null);
      mappingTemplateId = template.id;
    }

    const { batch, rows } = await previewAttendanceImport(req.file.originalname, parsed, resolvedMapping, mappingTemplateId, req.user?.userId ?? null);
    return res.status(201).json({ batch, preview: rows });
  } catch (err) {
    if (mapAttendanceImportError(err, res)) return;
    throw err;
  }
}));

router.post("/commit/:batchId", requirePermission("attendance.import.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await commitAttendanceImport(req.user?.userId ?? null, Number(req.params.batchId));
    return res.status(200).json(result);
  } catch (err) {
    if (mapAttendanceImportError(err, res)) return;
    throw err;
  }
}));

router.post("/:batchId/rollback", requirePermission("attendance.import.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await rollbackAttendanceImport(req.user!.userId, Number(req.params.batchId));
    return res.status(200).json(result);
  } catch (err) {
    if (mapAttendanceImportError(err, res)) return;
    throw err;
  }
}));

router.get("/history", requirePermission("attendance.import.view"), asyncHandler(async (_req: Request, res: Response) => {
  const batches = await listBatches();
  return res.status(200).json(batches);
}));

router.get("/mapping-templates", requirePermission("attendance.import.view"), asyncHandler(async (_req: Request, res: Response) => {
  const templates = await listMappingTemplates();
  return res.status(200).json(templates);
}));

router.get("/:batchId", requirePermission("attendance.import.view"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const batch = await getBatch(Number(req.params.batchId));
    return res.status(200).json(batch);
  } catch (err) {
    if (mapAttendanceImportError(err, res)) return;
    throw err;
  }
}));

/** Error Log: rows with status='rejected' (or 'duplicate', via ?status=) for a batch. */
router.get("/:batchId/errors", requirePermission("attendance.import.view"), asyncHandler(async (req: Request, res: Response) => {
  const statusFilter = req.query.status ? String(req.query.status) : "rejected";
  const rows = await getBatchRows(Number(req.params.batchId), statusFilter);
  return res.status(200).json(rows);
}));

router.get("/:batchId/rows", requirePermission("attendance.import.view"), asyncHandler(async (req: Request, res: Response) => {
  const rows = await getBatchRows(Number(req.params.batchId));
  return res.status(200).json(rows);
}));

export default router;
