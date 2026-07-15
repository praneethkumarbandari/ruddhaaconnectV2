import { Router, type Request, type Response } from "express";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "../lib/audit.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();
router.use(requirePermission("customers.view"));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select * from customers order by customer_name`);
  return res.status(200).json(rows);
}));

router.post("/", requirePermission("customers.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { customerName, gstin, supplyType, email, phone, addressLine1, addressLine2, city, state, pincode } = req.body ?? {};
  if (!customerName) return res.status(400).json({ error: "customerName is required." });
  if (supplyType && !["intrastate", "interstate"].includes(supplyType)) {
    return res.status(400).json({ error: "supplyType must be 'intrastate' or 'interstate'." });
  }

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into customers (customer_name, gstin, supply_type, email, phone, address_line1, address_line2, city, state, pincode, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning *`,
      [customerName, gstin ?? null, supplyType ?? "intrastate", email ?? null, phone ?? null, addressLine1 ?? null, addressLine2 ?? null, city ?? null, state ?? null, pincode ?? null, req.user?.userId ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "create", module: "customer", recordId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
  return res.status(201).json(result);
}));

// FIX: this update endpoint did not exist at all — the Customers page
// could only ever create new records, never edit an existing one.
router.patch("/:id", requirePermission("customers.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { customerName, gstin, supplyType, email, phone, addressLine1, addressLine2, city, state, pincode } = req.body ?? {};
  if (supplyType && !["intrastate", "interstate"].includes(supplyType)) {
    return res.status(400).json({ error: "supplyType must be 'intrastate' or 'interstate'." });
  }
  // NOTE: customerName and supplyType are coalesced (null keeps the
  // existing value) purely as a defensive fallback — the current
  // frontend always sends both as real values (name is required
  // client-side; supplyType always has a dropdown default), so this
  // never actually triggers in practice.
  //
  // Every other field below is a DIRECT overwrite, not coalesced —
  // deliberately. The only caller today (content/customers.html) always
  // resends the full form, including a field the user just intentionally
  // cleared. Coalescing here would silently keep the OLD value any time
  // someone tries to clear an email/phone/address, which is worse than
  // today's behavior, not better. If a true partial-update caller is
  // ever added (sending only the fields it wants to change), it should
  // use a sparse object and this endpoint would need a different
  // "field present vs field null" distinction than plain SQL coalesce
  // can express — not simply switching every field to coalesce.
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from customers where id = $1`, [id]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(
      `update customers set
         customer_name = coalesce($2, customer_name),
         gstin = $3, supply_type = coalesce($4, supply_type),
         email = $5, phone = $6, address_line1 = $7, address_line2 = $8,
         city = $9, state = $10, pincode = $11, updated_by = $12, updated_at = now()
       where id = $1 returning *`,
      [id, customerName ?? null, gstin ?? null, supplyType ?? null, email ?? null, phone ?? null, addressLine1 ?? null, addressLine2 ?? null, city ?? null, state ?? null, pincode ?? null, req.user?.userId ?? null],
    );
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "update", module: "customer", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
  if (!result) return res.status(404).json({ error: "Customer not found." });
  return res.status(200).json(result);
}));

router.post("/:id/deactivate", requirePermission("customers.manage"), asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from customers where id = $1`, [id]);
    if (existing.length === 0) return null;
    const { rows } = await client.query(`update customers set is_active = false, updated_by = $2, updated_at = now() where id = $1 returning *`, [id, req.user?.userId ?? null]);
    await writeAudit(client, { userId: req.user?.userId ?? null, action: "deactivate", module: "customer", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
  if (!result) return res.status(404).json({ error: "Customer not found." });
  return res.status(200).json(result);
}));

export default router;
