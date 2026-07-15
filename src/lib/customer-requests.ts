import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";

/**
 * content/customer-requests.html previously joined
 * customers(name, email) — columns that don't exist on the real
 * customers table (schema-phase2.sql only has customer_name, no email
 * column at all). This service reads the real customer_name column
 * instead; email is simply omitted from the response since there is
 * nowhere to read it from (a pre-existing gap in the request UI's
 * assumptions, not something this migration can invent data for).
 */

export class CustomerRequestNotFoundError extends Error {
  constructor(id: number) {
    super(`Customer request ${id} not found.`);
    this.name = "CustomerRequestNotFoundError";
  }
}

export async function listCustomerRequests() {
  const { rows } = await query(
    `select cr.*, c.customer_name
     from customer_requests cr
     join customers c on c.id = cr.customer_id
     order by cr.created_at desc`,
  );
  return rows;
}

export async function updateCustomerRequestStatus(id: number, status: string, userId: number | null) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from customer_requests where id = $1`, [id]);
    if (existing.length === 0) throw new CustomerRequestNotFoundError(id);

    const { rows } = await client.query(
      `update customer_requests set status = $2, updated_at = now() where id = $1 returning *`,
      [id, status],
    );
    await writeAudit(client, {
      userId, action: "update", module: "customer_requests",
      recordId: id, oldValue: { status: existing[0].status }, newValue: { status },
    });
    return rows[0];
  });
}
