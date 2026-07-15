import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import {
  listInventory, getInventoryItem, createInventoryItem, updateInventoryItem, recordStockMovement,
  InventoryItemNotFoundError, DuplicateItemCodeError, InsufficientStockError,
} from "../lib/inventory.ts";

const router = Router();
router.use(requirePermission("inventory.view"));

function mapInventoryError(err: unknown, res: Response): boolean {
  if (err instanceof InventoryItemNotFoundError) { res.status(404).json({ error: err.message }); return true; }
  if (err instanceof DuplicateItemCodeError) { res.status(409).json({ error: err.message }); return true; }
  if (err instanceof InsufficientStockError) { res.status(422).json({ error: err.message }); return true; }
  return false;
}

/**
 * Returns { items, transactions } — the exact two collections
 * content/inventory.html previously loaded itself via two parallel
 * Supabase queries (db.from("inventory"), db.from("inventory_transactions")),
 * combined into one call so the frontend's loadInventory() only needs
 * one round trip instead of two.
 */
router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const result = await listInventory();
  return res.status(200).json(result);
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  try {
    const item = await getInventoryItem(Number(req.params.id));
    return res.status(200).json(item);
  } catch (err) {
    if (mapInventoryError(err, res)) return;
    throw err;
  }
}));

router.post("/", requirePermission("inventory.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { name, category, uom, openingQty, minStock, hsn, gst, purchaseRate, saleRate, description, status } = req.body ?? {};
  if (!name || !uom) return res.status(400).json({ error: "name and uom are required." });
  try {
    const item = await createInventoryItem({
      name, category, uom,
      openingQty: Number(openingQty) || 0,
      minStock: Number(minStock) || 0,
      hsn, gst: Number(gst) || 0,
      purchaseRate: Number(purchaseRate) || 0,
      saleRate: Number(saleRate) || 0,
      description, status: status || "Active",
      userId: req.user?.userId ?? null,
    });
    return res.status(201).json(item);
  } catch (err) {
    if (mapInventoryError(err, res)) return;
    throw err;
  }
}));

router.patch("/:id", requirePermission("inventory.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { name, category, uom, minStock, hsn, gst, purchaseRate, saleRate, description, status } = req.body ?? {};
  try {
    const item = await updateInventoryItem(Number(req.params.id), {
      name, category, uom,
      minStock: Number(minStock) || 0,
      hsn, gst: Number(gst) || 0,
      purchaseRate: Number(purchaseRate) || 0,
      saleRate: Number(saleRate) || 0,
      description, status,
      userId: req.user?.userId ?? null,
    });
    return res.status(200).json(item);
  } catch (err) {
    if (mapInventoryError(err, res)) return;
    throw err;
  }
}));

/**
 * Stock In / Stock Out — the same two-write operation
 * (insert inventory_transactions + update inventory.current_stock)
 * content/inventory.html previously performed as two separate,
 * non-atomic Supabase calls; now atomic inside one transaction.
 */
router.post("/:id/stock-movement", requirePermission("inventory.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { transactionDate, transactionType, qty, remarks } = req.body ?? {};
  if (!transactionDate || !transactionType || !qty) {
    return res.status(400).json({ error: "transactionDate, transactionType, and qty are required." });
  }
  if (!["IN", "OUT"].includes(transactionType)) {
    return res.status(400).json({ error: "transactionType must be 'IN' or 'OUT'." });
  }
  try {
    const result = await recordStockMovement({
      itemId: Number(req.params.id),
      transactionDate, transactionType, qty: Number(qty), remarks,
      userId: req.user?.userId ?? null,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (mapInventoryError(err, res)) return;
    throw err;
  }
}));

export default router;
