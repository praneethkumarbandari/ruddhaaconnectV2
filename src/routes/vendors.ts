import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "../lib/audit.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("vendors.view"));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from vendors order by vendor_name`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("vendors.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { vendorName, gstin, pan, supplyType, email, phone, addressLine1, addressLine2, city, state, pincode } = req.body ?? {};
  if (!vendorName) return res.status(400).json({ error: "vendorName is required." });
  if (supplyType && !["intrastate", "interstate"].includes(supplyType)) {
    return res.status(400).json({ error: "supplyType must be 'intrastate' or 'interstate'." });
  }

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into vendors (vendor_name, gstin, pan, supply_type, email, phone, address_line1, address_line2, city, state, pincode, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) returning *`,
      [vendorName, gstin ?? null, pan ?? null, supplyType ?? "intrastate", email ?? null, phone ?? null, addressLine1 ?? null, addressLine2 ?? null, city ?? null, state ?? null, pincode ?? null, req.user?.userId ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "vendor", recordId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
  return res.status(201).json(result);
}));

// FIX: this update endpoint did not exist at all — the Vendors page
// could only ever create new records, never edit an existing one.
router.patch("/:id", requirePermission("vendors.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { vendorName, gstin, pan, supplyType, email, phone, addressLine1, addressLine2, city, state, pincode } = req.body ?? {};
  if (supplyType && !["intrastate", "interstate"].includes(supplyType)) {
    return res.status(400).json({ error: "supplyType must be 'intrastate' or 'interstate'." });
  }
  // See the identical note in routes/customers.ts: everything except
  // vendorName/supplyType is a deliberate direct overwrite, not
  // coalesced, because the only caller today always resends the full
  // form including intentional clears.
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from vendors where id = $1`, [id]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(
      `update vendors set
         vendor_name = coalesce($2, vendor_name),
         gstin = $3, pan = $4, supply_type = coalesce($5, supply_type),
         email = $6, phone = $7, address_line1 = $8, address_line2 = $9,
         city = $10, state = $11, pincode = $12, updated_by = $13, updated_at = now()
       where id = $1 returning *`,
      [id, vendorName ?? null, gstin ?? null, pan ?? null, supplyType ?? null, email ?? null, phone ?? null, addressLine1 ?? null, addressLine2 ?? null, city ?? null, state ?? null, pincode ?? null, req.user?.userId ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "vendor", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
  if (!result) return res.status(404).json({ error: "Vendor not found." });
  return res.status(200).json(result);
}));

router.post("/:id/deactivate", requirePermission("vendors.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from vendors where id = $1`, [id]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(`update vendors set is_active = false, updated_by = $2, updated_at = now() where id = $1 returning *`, [id, req.user?.userId ?? null]);
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "deactivate", module: "vendor", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
  if (!result) return res.status(404).json({ error: "Vendor not found." });
  return res.status(200).json(result);
}));

export default router;
