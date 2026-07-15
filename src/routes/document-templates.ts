import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "../lib/audit.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("templates.view"));

/**
 * List with search + category filter + pagination, in one query —
 * same "search across the visible text fields, filter narrows it,
 * pagination caps the response" shape every other list in this app
 * already uses, not a one-off pattern just for this page.
 */
router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const { q, category, page, pageSize } = req.query as Record<string, string>;
  const limit = Math.min(Number(pageSize) || 20, 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const conditions: string[] = ["is_active = true"];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(name ilike $${params.length} or body ilike $${params.length})`);
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";

  const { rows: countRows } = await query(`select count(*)::int as total from document_templates ${where}`, params);
  params.push(limit, offset);
  const { rows } = await query(
    `select * from document_templates ${where} order by updated_at desc limit $${params.length - 1} offset $${params.length}`,
    params,
  );

  return res.status(200).json({ rows, total: countRows[0].total, page: Number(page) || 1, pageSize: limit });
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await query(`select * from document_templates where id = $1`, [Number(req.params.id)]);
  if (rows.length === 0) return res.status(404).json({ error: "Template not found." });
  return res.status(200).json(rows[0]);
}));

router.post("/", requirePermission("templates.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { name, category, subject, body } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name is required." });

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into document_templates (name, category, subject, body, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $5) returning *`,
      [name, category || "general", subject ?? null, body ?? "", req.user?.userId ?? null],
    );
    const record = rows[0];
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "document_template", recordId: record.id, newValue: record });
    return record;
  });
  return res.status(201).json(result);
}));

router.patch("/:id", requirePermission("templates.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, category, subject, body } = req.body ?? {};

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from document_templates where id = $1`, [id]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(
      `update document_templates set
         name = coalesce($2, name), category = coalesce($3, category),
         subject = $4, body = coalesce($5, body), updated_by = $6, updated_at = now()
       where id = $1 returning *`,
      [id, name ?? null, category ?? null, subject ?? existing[0].subject, body ?? null, req.user?.userId ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "document_template", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });

  if (!result) return res.status(404).json({ error: "Template not found." });
  return res.status(200).json(result);
}));

/**
 * Duplicate: real copy, real new row, real new id — not a shallow
 * reference back to the original that would edit both at once.
 */
router.post("/:id/duplicate", requirePermission("templates.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from document_templates where id = $1`, [id]);
    if (existing.length === 0) return null;
    const src = existing[0];
    const { rows } = await client.query(
      `insert into document_templates (name, category, subject, body, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $5) returning *`,
      [`${src.name} (Copy)`, src.category, src.subject, src.body, req.user?.userId ?? null],
    );
    const record = rows[0];
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "document_template", recordId: record.id, newValue: { ...record, duplicatedFrom: id } });
    return record;
  });
  if (!result) return res.status(404).json({ error: "Template not found." });
  return res.status(201).json(result);
}));

/** Deactivate only — same rule as every other master in this system: history may reference this row. */
router.post("/:id/deactivate", requirePermission("templates.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from document_templates where id = $1`, [id]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(
      `update document_templates set is_active = false, updated_by = $2, updated_at = now() where id = $1 returning *`,
      [id, req.user?.userId ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "deactivate", module: "document_template", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
  if (!result) return res.status(404).json({ error: "Template not found." });
  return res.status(200).json(result);
}));

export default router;
