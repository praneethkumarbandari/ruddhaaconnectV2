import { Router, type Request, type Response } from "express";
import multer from "multer";
import { withTransaction } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { handleDomainError } from "../lib/error-mapping.ts";
import { requirePermission } from "../middleware/permission.ts";
import {
  parseFile,
  autoDetectMapping,
  missingRequiredFields,
  applyMapping,
  validateRow,
  commitImport,
  listBatches,
  getBatch,
  getBatchRows,
  matchRowParty,
  saveMappingTemplate,
  listMappingTemplates,
  createDraftFromRow,
  markRowPosted,
  EmptyFileError,
  CorruptFileError,
  MappingIncompleteError,
  BatchNotFoundError,
  RowNotFoundError,
  RowNotReadyError,
  PartyNotMatchedError,
} from "../lib/bank-import.ts";
// These are the EXISTING, unmodified functions — imported, not
// reimplemented. This import list is the architectural proof that the
// import engine calls into the real accounting engine rather than
// duplicating it.
import { createDraftReceipt, postReceipt } from "../lib/receipts.ts";
import { createDraftPayment, postPayment } from "../lib/payments.ts";

const router = Router();
router.use(requirePermission("bank-import.view"));
const ALLOWED_IMPORT_EXTENSIONS = /\.(csv|xlsx|xls)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMPORT_EXTENSIONS.test(file.originalname)) {
      return cb(new Error("Only .csv, .xlsx, or .xls files are accepted."));
    }
    cb(null, true);
  },
});

function mapBankImportError(err: unknown, res: Response): boolean {
  if (
    err instanceof EmptyFileError ||
    err instanceof CorruptFileError ||
    err instanceof MappingIncompleteError
  ) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof BatchNotFoundError || err instanceof RowNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  if (err instanceof RowNotReadyError || err instanceof PartyNotMatchedError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

/** Preview: parse + auto-detect mapping + show first rows. No DB writes. */
router.post("/preview", upload.single("file"), asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "A file is required (field name: file)." });
  try {
    const parsed = await parseFile(req.file.buffer, req.file.originalname);
    const suggestedMapping = autoDetectMapping(parsed.headers);
    const missing = missingRequiredFields(suggestedMapping);
    return res.status(200).json({
      headers: parsed.headers,
      totalDataRows: parsed.rows.length,
      previewRows: parsed.rows.slice(0, 10),
      suggestedMapping,
      missingRequiredFields: missing,
      mappingComplete: missing.length === 0,
    });
  } catch (err) {
    if (mapBankImportError(err, res)) return;
    throw err;
  }
}));

/** Preview validation only (no DB writes) — lets the UI show what would happen before committing. */
router.post("/preview-validate", upload.single("file"), asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "A file is required (field name: file)." });
  const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};
  try {
    const parsed = await parseFile(req.file.buffer, req.file.originalname);
    const mapped = applyMapping(parsed, mapping);
    const validated = mapped.map(validateRow);
    return res.status(200).json({
      totalRows: validated.length,
      validCount: validated.filter((r) => r.valid).length,
      invalidCount: validated.filter((r) => !r.valid).length,
      rows: validated,
    });
  } catch (err) {
    if (mapBankImportError(err, res)) return;
    throw err;
  }
}));

/** Mapping templates */
router.get("/mapping-templates", asyncHandler(async (_req: Request, res: Response) => {
  const templates = await listMappingTemplates();
  return res.status(200).json(templates);
}));

router.post("/mapping-templates", requirePermission("bank-import.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { templateName, bankAccountCode, columnMapping } = req.body ?? {};
  if (!templateName || !bankAccountCode || !columnMapping) {
    return res.status(400).json({ error: "templateName, bankAccountCode, and columnMapping are required." });
  }
  const missing = missingRequiredFields(columnMapping);
  if (missing.length > 0) return res.status(400).json({ error: `Cannot save an incomplete mapping — missing: ${missing.join(", ")}.` });
  const template = await saveMappingTemplate(templateName, bankAccountCode, columnMapping, req.user?.userId ?? null);
  return res.status(201).json(template);
}));

/** Commit the import: parse + validate + de-duplicate + write to the queue. Still not accounting. */
router.post("/", upload.single("file"), requirePermission("bank-import.manage"), asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "A file is required (field name: file)." });
  const { bankAccountCode, mappingTemplateId } = req.body ?? {};
  const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};
  if (!bankAccountCode) return res.status(400).json({ error: "bankAccountCode is required." });
  try {
    const batch = await withTransaction((client) =>
      commitImport(client, {
        fileName: req.file!.originalname,
        bankAccountCode,
        mappingTemplateId: mappingTemplateId ? Number(mappingTemplateId) : null,
        buffer: req.file!.buffer,
        mapping,
        userId: req.user?.userId ?? null,
      }),
    );
    return res.status(201).json(batch);
  } catch (err) {
    if (mapBankImportError(err, res)) return;
    throw err;
  }
}));

/** Import history */
router.get("/history", asyncHandler(async (_req: Request, res: Response) => {
  const batches = await listBatches();
  return res.status(200).json(batches);
}));

router.get("/:batchId", asyncHandler(async (req: Request, res: Response) => {
  try {
    const batch = await getBatch(Number(req.params.batchId));
    return res.status(200).json(batch);
  } catch (err) {
    if (mapBankImportError(err, res)) return;
    throw err;
  }
}));

/** The import queue for a batch */
router.get("/:batchId/rows", asyncHandler(async (req: Request, res: Response) => {
  try {
    const rows = await getBatchRows(Number(req.params.batchId));
    return res.status(200).json(rows);
  } catch (err) {
    if (mapBankImportError(err, res)) return;
    throw err;
  }
}));

/** Manually match a queue row to an existing customer or vendor — never automatic. */
router.post("/rows/:rowId/match-party", requirePermission("bank-import.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { partyType, partyId } = req.body ?? {};
  if (!partyType || !partyId || !["customer", "vendor"].includes(partyType)) {
    return res.status(400).json({ error: "partyType ('customer' or 'vendor') and partyId are required." });
  }
  try {
    const row = await withTransaction((client) => matchRowParty(client, Number(req.params.rowId), partyType, Number(partyId)));
    return res.status(200).json(row);
  } catch (err) {
    if (mapBankImportError(err, res)) return;
    throw err;
  }
}));

/**
 * Creates a draft Receipt or Payment from this row — by calling the
 * existing createDraftReceipt/createDraftPayment functions, injected
 * here as deps. Nothing accounting-specific is computed in this route
 * or in bank-import.ts; the real functions do exactly what they'd do
 * for a manually entered transaction.
 */
router.post("/rows/:rowId/create-draft", requirePermission("bank-import.manage"), asyncHandler(async (req: Request, res: Response) => {
  const allocations = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
  try {
    const result = await withTransaction((client) =>
      createDraftFromRow(
        client,
        Number(req.params.rowId),
        { createDraftReceipt, createDraftPayment },
        req.user?.userId ?? null,
        allocations,
      ),
    );
    return res.status(201).json(result);
  } catch (err) {
    if (mapBankImportError(err, res)) return;
    handleDomainError(err, res);
  }
}));

/**
 * Posts the row's draft through the EXISTING posting path
 * (postReceipt/postPayment, unmodified — the same functions
 * /api/receipts/:id/post and /api/payments/:id/post call), then marks
 * the queue row as 'posted'. This is the step where the imported
 * transaction actually becomes a journal entry — and it does so
 * through the same function every other posting in this system uses.
 */
router.post("/rows/:rowId/post", requirePermission("bank-import.manage"), asyncHandler(async (req: Request, res: Response) => {
  try {
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query(`select * from bank_import_rows where id = $1`, [req.params.rowId]);
      if (rows.length === 0) throw new RowNotFoundError(Number(req.params.rowId));
      const r = rows[0];
      if (r.status !== "draft_created") throw new RowNotReadyError(Number(req.params.rowId), r.status);

      if (r.draft_receipt_id) {
        await postReceipt(client, r.draft_receipt_id, req.user?.userId ?? null);
      } else if (r.draft_payment_id) {
        await postPayment(client, r.draft_payment_id, req.user?.userId ?? null);
      } else {
        throw new Error(`Row ${r.id} has no draft to post.`);
      }
      return markRowPosted(client, Number(req.params.rowId));
    });
    return res.status(200).json(row);
  } catch (err) {
    if (mapBankImportError(err, res)) return;
    handleDomainError(err, res);
  }
}));

export default router;
