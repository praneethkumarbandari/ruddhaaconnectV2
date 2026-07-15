import { Router, type Request, type Response } from "express";
import { pool, query } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();

/**
 * FIX (theme not saving/persisting): js/shell.js and js/theme.js used to
 * read portal_config directly from Supabase (`db.from('portal_config')`)
 * on every single page load, completely bypassing the backend and its
 * tenant schema (search_path). That call resolved against whatever
 * portal_config row the Supabase client's default connection saw — not
 * necessarily this tenant's real, just-saved row — and then immediately
 * overwrote the correct value that had just been cached to localStorage
 * by a successful Settings save, AND persisted that wrong value back
 * into localStorage. So a save would visibly apply, then silently
 * "undo" itself the next time any page loaded. That's the actual,
 * confirmed root cause of "theme not saving".
 *
 * This route is the fix: a tenant-scoped read every authenticated
 * employee can call regardless of role — branding needs to render for
 * everyone, not just settings admins. Deliberately mounted BEFORE the
 * router.use(requirePermission("admin.settings.view")) gate below (not
 * just given a different permission code), since that gate is meant to
 * protect the real Settings page/data, not the ability to see your own
 * company's logo and colors. Returns only the display-relevant subset,
 * not the full portal_config row (no gst_number, support_email, etc.).
 */
router.get("/branding", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(
    `select company_name, logo_path, primary_color, secondary_color, background_color,
            font_family, text_color, heading_color, card_color, menu_color, menu_text_color,
            kpi_title_color, kpi_content_color
     from portal_config limit 1`,
  );
  return res.status(200).json(rows[0] || {});
}));

router.use(requirePermission("admin.settings.view"));

const EDITABLE_FIELDS = [
  "company_name", "logo_path", "address", "company_state", "gst_number",
  "support_phone", "support_email", "website", "currency", "font_family",
  "pdf_template_style", "primary_color", "secondary_color", "background_color",
  "text_color", "heading_color", "card_color", "menu_color", "menu_text_color",
  "kpi_title_color", "kpi_content_color",
  "notify_email_enabled", "notify_sms_enabled", "notify_whatsapp_enabled",
] as const;

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from portal_config limit 1`);
  return res.status(200).json(rows[0] || {});
}));

router.patch("/", requirePermission("admin.settings.manage"), asyncHandler(async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const updates: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in body) updates[field] = body[field];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No editable fields supplied." });
  }

  const { rows: existing } = await query(`select id from portal_config limit 1`);
  const keys = Object.keys(updates);
  const values = Object.values(updates);

  if (existing.length === 0) {
    const cols = keys.join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await query(
      `insert into portal_config (${cols}) values (${placeholders}) returning *`,
      values,
    );
    return res.status(201).json(rows[0]);
  }

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const { rows } = await query(
    `update portal_config set ${setClause} where id = $${keys.length + 1} returning *`,
    [...values, existing[0].id],
  );
  return res.status(200).json(rows[0]);
}));

/**
 * Real, working manual data export — downloads core master and
 * transactional data as one JSON file, right now, no separate
 * infrastructure needed.
 *
 * Honest about what this is NOT: not scheduled/automatic, not stored
 * anywhere (the business downloads and keeps the file themselves),
 * and there's no matching "Restore" endpoint. A restore feature that
 * overwrites live data incorrectly could be genuinely destructive —
 * that's real, separate, careful work, not something to bundle in
 * alongside a UI pass.
 */
router.get("/backup-export", requirePermission("admin.settings.manage"), asyncHandler(async (_req: Request, res: Response) => {
  const [customers, vendors, chartOfAccounts, employees, salesInvoices, purchaseInvoices, journalEntries, bankAccounts, portalConfig] = await Promise.all([
    query(`select * from customers order by id`),
    query(`select * from vendors order by id`),
    query(`select * from chart_of_accounts order by account_code`),
    query(`select id, username, employee_name, email, role, is_active from employees order by id`),
    query(`select id, invoice_no, invoice_date, customer_id, subtotal, gst_amount, total, status from sales_invoices order by id`),
    query(`select id, vendor_invoice_no, invoice_date, vendor_id, subtotal, gst_amount, total, status from purchase_invoices order by id`),
    query(`select id, je_no, entry_date, narration, status from journal_entries order by id`),
    query(`select * from bank_accounts order by id`),
    query(`select * from portal_config limit 1`),
  ]);

  const backup = {
    exported_at: new Date().toISOString(),
    company: portalConfig.rows[0] || null,
    customers: customers.rows,
    vendors: vendors.rows,
    chart_of_accounts: chartOfAccounts.rows,
    employees: employees.rows,
    sales_invoices: salesInvoices.rows,
    purchase_invoices: purchaseInvoices.rows,
    journal_entries: journalEntries.rows,
    bank_accounts: bankAccounts.rows,
  };

  const filename = `ruddhaa-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(JSON.stringify(backup, null, 2));
}));

export default router;
