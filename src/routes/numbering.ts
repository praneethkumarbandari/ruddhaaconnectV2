import { Router, type Request, type Response } from "express";
import { pool, query, withTransaction } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import { writeAudit } from "../lib/audit.ts";

/**
 * Read-only preview of the next document number for a given type.
 * Deliberately does NOT call nextDocumentNumber() (src/lib/number-
 * generator.ts) — that function takes a row lock and increments the
 * counter as part of a real posting transaction. Calling it just to
 * show a preview would consume a real number every time someone
 * opens the Create Invoice page without ever saving, leaving gaps in
 * the sequence. This only ever SELECTs the current value.
 *
 * DELIBERATELY UNGATED (no requirePermission): used directly inside
 * invoices-create.html, which any employee creating an invoice needs
 * regardless of role — gating this behind a specific permission would
 * risk breaking ordinary invoice creation for anyone who lacks it. It
 * only exposes the next sequential number, not financial data, so the
 * risk of leaving it open is low. This was checked deliberately, not
 * missed — see the "pending items" review that flagged it.
 *
 * Same prefix defaults as the real generator (see
 * src/lib/number-generator.ts's defaultPrefix()) — kept in sync
 * manually since this is a preview of that exact logic, not a
 * second, independent implementation of it.
 */

const DEFAULT_PREFIXES: Record<string, string> = {
  journal_entry: "JE-",
  invoice: "INV-",
  receipt: "RCP-",
  payment: "PAY-",
  purchase: "PUR-",
  contra: "CON-",
  credit_note: "CN-",
  debit_note: "DN-",
  sales_invoice: "SI-",
  purchase_invoice: "PI-",
  goods_return: "GR-",
};

const KNOWN_DOCUMENT_TYPES = [
  "sales_invoice", "purchase_invoice", "goods_return", "debit_note", "credit_note",
  "journal_entry", "receipt", "payment", "contra",
];

const router = Router();

router.get("/preview", asyncHandler(async (req: Request, res: Response) => {
  const documentType = String(req.query.documentType ?? "");
  if (!documentType) return res.status(400).json({ error: "documentType is required." });

  const { rows: fyRows } = await query(`select id from financial_years where status = 'open' limit 1`);
  if (fyRows.length === 0) return res.status(404).json({ error: "No open financial year found." });
  const financialYearId = fyRows[0].id;

  const { rows } = await query(
    `select prefix, separator, next_number, padding, suffix from numbering_sequences where document_type = $1 and financial_year_id = $2`,
    [documentType, financialYearId],
  );

  const prefix = rows[0]?.prefix ?? DEFAULT_PREFIXES[documentType] ?? `${documentType.toUpperCase()}-`;
  // FIX: separator and suffix used to be silently dropped here too —
  // this preview must match what nextDocumentNumber() actually
  // produces at save time, or the number shown on the Create Invoice
  // page would misleadingly differ from the one that gets assigned.
  const separator = rows[0]?.separator ?? "";
  const suffix = rows[0]?.suffix ?? "";
  const nextNumber = rows[0]?.next_number ?? 1;
  const padding = rows[0]?.padding ?? 4;
  const formatted = `${prefix}${separator}${String(nextNumber).padStart(padding, "0")}${suffix}`;

  return res.status(200).json({ next: nextNumber, formatted });
}));

/**
 * FIX: content/settings.html's Numbering & Prefixes tab used to read
 * and write numbering_sequences directly via Supabase
 * (db.from('numbering_sequences')...), bypassing the backend and its
 * tenant schema (search_path) entirely — the exact same class of bug
 * as the theme-not-persisting issue (see settings.ts's /branding
 * route). A save there could land in the wrong schema (or fail
 * outright), while invoice creation always reads through the
 * correctly tenant-scoped backend — so configured prefixes/suffixes
 * never actually reached real invoices. These routes are the fix:
 * the same list/create/update shape the frontend already expects,
 * now properly tenant-scoped.
 *
 * Gated the same way the rest of Settings is (admin.settings.view /
 * .manage) — prefix/suffix configuration is an admin concern, not
 * something every employee needs write access to (unlike /preview
 * above, which every invoice-creating employee needs to read).
 */
router.get("/sequences", requirePermission("admin.settings.view"), asyncHandler(async (_req: Request, res: Response) => {
  const { rows: fyRows } = await query(`select id from financial_years where status = 'open' limit 1`);
  const financialYearId = fyRows[0]?.id ?? null;

  const { rows: existing } = await query(`select * from numbering_sequences order by document_type`);
  const byType = new Map(existing.map((r: any) => [r.document_type, r]));

  // Same synthesis the frontend used to do client-side: every known
  // document type gets an editable row even before its first real
  // document is ever posted (which is the only time a row would
  // otherwise get created — see number-generator.ts).
  const rows = KNOWN_DOCUMENT_TYPES.map((t) => byType.get(t) ?? {
    id: null, document_type: t, financial_year_id: financialYearId,
    prefix: "", separator: "-", next_number: 1, padding: 4, suffix: "", is_active: true,
  });
  for (const r of existing) {
    if (!KNOWN_DOCUMENT_TYPES.includes(r.document_type)) rows.push(r);
  }
  return res.status(200).json(rows);
}));

router.post("/sequences", requirePermission("admin.settings.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { documentType, prefix, separator, nextNumber, padding, suffix, isActive } = req.body ?? {};
  if (!documentType) return res.status(400).json({ error: "documentType is required." });

  const { rows: fyRows } = await query(`select id from financial_years where status = 'open' limit 1`);
  if (fyRows.length === 0) return res.status(404).json({ error: "No open financial year found — cannot create a numbering sequence." });
  const financialYearId = fyRows[0].id;

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into numbering_sequences (document_type, financial_year_id, prefix, separator, next_number, padding, suffix, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [documentType, financialYearId, prefix ?? "", separator ?? "-", Number(nextNumber) || 1, Number(padding) || 4, suffix ?? "", isActive ?? true],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "numbering_sequences", recordId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
  return res.status(201).json(result);
}));

router.patch("/sequences/:id", requirePermission("admin.settings.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { prefix, separator, nextNumber, padding, suffix, isActive } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from numbering_sequences where id = $1`, [id]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(
      `update numbering_sequences set
         prefix = coalesce($2, prefix), separator = coalesce($3, separator),
         next_number = coalesce($4, next_number), padding = coalesce($5, padding),
         suffix = coalesce($6, suffix), is_active = coalesce($7, is_active),
         updated_at = now()
       where id = $1 returning *`,
      [id, prefix, separator, nextNumber != null ? Number(nextNumber) : null, padding != null ? Number(padding) : null, suffix, isActive],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "numbering_sequences", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
  if (!result) return res.status(404).json({ error: "Numbering sequence not found." });
  return res.status(200).json(result);
}));

export default router;
