import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";

export class CostingRecordNotFoundError extends Error {
  constructor(id: number) {
    super(`Cost sheet ${id} not found.`);
    this.name = "CostingRecordNotFoundError";
  }
}

export async function listCostingRecords() {
  const { rows } = await query(`select * from costing_records order by created_at desc`);
  return rows;
}

export type CostingRecordInput = {
  sheetName: string;
  itemCode?: string | null;
  projectId?: number | null;
  materialCost: number;
  labourCost: number;
  overheadCost: number;
  notes?: string | null;
  userId: number | null;
};

function totalCost(input: CostingRecordInput): number {
  return input.materialCost + input.labourCost + input.overheadCost;
}

export async function createCostingRecord(input: CostingRecordInput) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into costing_records (sheet_name, item_code, project_id, material_cost, labour_cost, overhead_cost, total_cost, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning *`,
      [
        input.sheetName, input.itemCode ?? null, input.projectId ?? null,
        input.materialCost, input.labourCost, input.overheadCost, totalCost(input),
        input.notes ?? null, input.userId,
      ],
    );
    const record = rows[0];
    await writeAudit(client, {
      userId: input.userId, action: "create", module: "costing_records",
      recordId: record.id, newValue: { sheet_name: input.sheetName },
    });
    return record;
  });
}

export async function updateCostingRecord(id: number, input: CostingRecordInput) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from costing_records where id = $1`, [id]);
    if (existing.length === 0) throw new CostingRecordNotFoundError(id);

    const { rows } = await client.query(
      `update costing_records set
         sheet_name = $2, item_code = $3, project_id = $4, material_cost = $5,
         labour_cost = $6, overhead_cost = $7, total_cost = $8, notes = $9, updated_at = now()
       where id = $1
       returning *`,
      [
        id, input.sheetName, input.itemCode ?? null, input.projectId ?? null,
        input.materialCost, input.labourCost, input.overheadCost, totalCost(input), input.notes ?? null,
      ],
    );
    await writeAudit(client, {
      userId: input.userId, action: "update", module: "costing_records",
      recordId: id, oldValue: existing[0], newValue: rows[0],
    });
    return rows[0];
  });
}
