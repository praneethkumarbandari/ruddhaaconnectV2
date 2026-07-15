import type { PgClient } from "../db/pool.ts";
import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";

/**
 * Inventory service layer.
 *
 * Column names here are exactly what the real `inventory` /
 * `inventory_transactions` tables already use (code, name, min_stock,
 * hsn, gst, opening_qty, current_stock, qty, balance_after) — the
 * frontend's own "FIX:" comments document these as the actual
 * columns, discovered after a previous debugging pass corrected the
 * page's field names to match the database rather than the other way
 * around. This service preserves those exact names and exact
 * behavior; nothing about the data model changed in this migration,
 * only where the logic that reads/writes it lives.
 */

export class InventoryItemNotFoundError extends Error {
  constructor(id: number) {
    super(`Inventory item ${id} not found.`);
    this.name = "InventoryItemNotFoundError";
  }
}

export class DuplicateItemCodeError extends Error {
  constructor(code: string) {
    super(`Item Code '${code}' already exists.`);
    this.name = "DuplicateItemCodeError";
  }
}

export class InsufficientStockError extends Error {
  constructor(available: number, requested: number) {
    super(`Insufficient stock: ${available} available, ${requested} requested.`);
    this.name = "InsufficientStockError";
  }
}

export async function listInventory() {
  const [itemsRes, txnsRes] = await Promise.all([
    query(`select * from inventory order by code asc`),
    query(`select * from inventory_transactions order by transaction_date asc, id asc`),
  ]);
  return { items: itemsRes.rows, transactions: txnsRes.rows };
}

export async function getInventoryItem(id: number) {
  const { rows } = await query(`select * from inventory where id = $1`, [id]);
  if (rows.length === 0) throw new InventoryItemNotFoundError(id);
  return rows[0];
}

/**
 * Next ITM-prefixed code, atomically. Mirrors the frontend's previous
 * client-side "find max ITM code, +1" logic exactly (same prefix,
 * same zero-padding width), just made race-safe with a row lock the
 * client-side version never had.
 */
async function nextItemCode(client: PgClient): Promise<string> {
  const { rows } = await client.query(
    `select code from inventory where code ilike 'ITM%' order by code desc limit 1 for update`,
  );
  let maxNum = 0;
  if (rows.length > 0) {
    const num = parseInt(String(rows[0].code).slice(3), 10);
    if (!isNaN(num)) maxNum = num;
  }
  return "ITM" + String(maxNum + 1).padStart(4, "0");
}

export type CreateInventoryItemInput = {
  name: string;
  category?: string | null;
  uom: string;
  openingQty: number;
  minStock: number;
  hsn?: string | null;
  gst: number;
  purchaseRate: number;
  saleRate: number;
  description?: string | null;
  status: string;
  userId: number | null;
};

export async function createInventoryItem(input: CreateInventoryItemInput) {
  // FIX: nextItemCode()'s "select max code for update" pattern has a
  // real race window -- confirmed live with concurrent requests -- when
  // two callers compute the same next code before either has inserted
  // (there's nothing yet to lock on an empty table, and even with
  // existing rows the window between computing the code and inserting
  // it isn't covered by the SELECT's row lock). The loser previously
  // surfaced "Item Code 'ITM0001' already exists" to a user who never
  // typed a code at all -- confusing and wrong, since this is an
  // auto-generated value, not user input to validate. Retry with a
  // freshly-computed code on exactly that collision, transparent to
  // the caller, instead of a full migration to a dedicated numbering-
  // sequence table (nextDocumentNumber's approach) for what's a much
  // lower-volume, lower-stakes identifier than financial vouchers.
  const MAX_ATTEMPTS = 15;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await withTransaction(async (client) => {
        const code = await nextItemCode(client);
        try {
          const { rows } = await client.query(
            `insert into inventory
               (code, name, category, uom, opening_qty, current_stock, min_stock, hsn, gst, purchase_rate, sale_rate, description, status)
             values ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12)
             returning *`,
            [
              code, input.name, input.category ?? null, input.uom, input.openingQty,
              input.minStock, input.hsn ?? null, input.gst, input.purchaseRate, input.saleRate,
              input.description ?? null, input.status,
            ],
          );
          const item = rows[0];
          await writeAudit(client, {
            userId: input.userId, action: "create", module: "inventory",
            recordId: item.id, newValue: { item_code: code, item_name: input.name },
          });
          return item;
        } catch (err) {
          const pgErr = err as { code?: string };
          if (pgErr.code === "23505") throw new DuplicateItemCodeError(code);
          throw err;
        }
      });
    } catch (err) {
      const isRaceOnAutoCode = err instanceof DuplicateItemCodeError;
      if (isRaceOnAutoCode && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
  // Unreachable (loop always returns or throws), but keeps TypeScript's
  // control-flow analysis happy about a return on every path.
  throw new Error("createInventoryItem: exhausted retry attempts.");
}

export type UpdateInventoryItemInput = {
  name: string;
  category?: string | null;
  uom: string;
  minStock: number;
  hsn?: string | null;
  gst: number;
  purchaseRate: number;
  saleRate: number;
  description?: string | null;
  status: string;
  userId: number | null;
};

export async function updateInventoryItem(id: number, input: UpdateInventoryItemInput) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from inventory where id = $1`, [id]);
    if (existing.length === 0) throw new InventoryItemNotFoundError(id);

    const { rows } = await client.query(
      `update inventory set
         name = $2, category = $3, uom = $4, min_stock = $5, hsn = $6, gst = $7,
         purchase_rate = $8, sale_rate = $9, description = $10, status = $11, updated_at = now()
       where id = $1
       returning *`,
      [
        id, input.name, input.category ?? null, input.uom, input.minStock, input.hsn ?? null,
        input.gst, input.purchaseRate, input.saleRate, input.description ?? null, input.status,
      ],
    );
    await writeAudit(client, {
      userId: input.userId, action: "update", module: "inventory",
      recordId: id, newValue: { item_name: input.name, status: input.status },
    });
    return rows[0];
  });
}

export type StockMovementInput = {
  itemId: number;
  transactionDate: string;
  transactionType: "IN" | "OUT";
  qty: number;
  remarks?: string | null;
  userId: number | null;
};

/**
 * Records a stock movement and updates the item's running balance in
 * the same transaction — exactly the two writes (insert transaction,
 * update current_stock) the frontend previously made as two separate,
 * non-atomic Supabase calls. OUT movements that would take stock
 * negative are rejected, same as the frontend's own pre-check.
 */
export async function recordStockMovement(input: StockMovementInput) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from inventory where id = $1 for update`, [input.itemId]);
    if (existing.length === 0) throw new InventoryItemNotFoundError(input.itemId);
    const item = existing[0];

    const currentStock = Number(item.current_stock) || 0;
    const newBalance = input.transactionType === "IN"
      ? currentStock + input.qty
      : currentStock - input.qty;

    if (input.transactionType === "OUT" && newBalance < 0) {
      throw new InsufficientStockError(currentStock, input.qty);
    }

    const { rows: txnRows } = await client.query(
      `insert into inventory_transactions
         (item_id, transaction_date, transaction_type, qty, balance_after, remarks, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      [input.itemId, input.transactionDate, input.transactionType, input.qty, newBalance, input.remarks ?? null, input.userId],
    );

    await client.query(`update inventory set current_stock = $2, updated_at = now() where id = $1`, [input.itemId, newBalance]);

    await writeAudit(client, {
      userId: input.userId,
      action: input.transactionType === "IN" ? "create" : "update",
      module: "inventory_transactions",
      recordId: input.itemId,
      oldValue: { current_stock: currentStock },
      newValue: { current_stock: newBalance, qty: input.qty, date: input.transactionDate },
    });

    return { transaction: txnRows[0], newBalance };
  });
}
