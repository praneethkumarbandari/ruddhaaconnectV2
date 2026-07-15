import { pool, withTransaction, query } from "../db/pool.ts";
import { writeAudit } from "./audit.ts";

export class CrmLeadNotFoundError extends Error {
  constructor(id: number) {
    super(`Lead ${id} not found.`);
    this.name = "CrmLeadNotFoundError";
  }
}
export class CrmFollowupNotFoundError extends Error {
  constructor(id: number) {
    super(`Follow-up ${id} not found.`);
    this.name = "CrmFollowupNotFoundError";
  }
}
export class CrmActivityNotFoundError extends Error {
  constructor(id: number) {
    super(`Activity ${id} not found.`);
    this.name = "CrmActivityNotFoundError";
  }
}

// ------------------------------------------------------------
// LEADS
// ------------------------------------------------------------

export async function listLeads() {
  const { rows } = await query(`select * from crm_leads order by created_at desc`);
  return rows;
}

export type LeadInput = {
  leadName: string;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  customerId?: number | null;
  status: string;
  estimatedValue?: number | null;
  source?: string | null;
  notes?: string | null;
  userId: number | null;
};

export async function createLead(input: LeadInput) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into crm_leads (lead_name, company, phone, email, customer_id, status, estimated_value, source, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        input.leadName, input.company ?? null, input.phone ?? null, input.email ?? null,
        input.customerId ?? null, input.status, input.estimatedValue ?? null, input.source ?? null,
        input.notes ?? null, input.userId,
      ],
    );
    const lead = rows[0];
    await writeAudit(client, { userId: input.userId, action: "create", module: "crm_leads", recordId: lead.id, newValue: { lead_name: input.leadName } });
    return lead;
  });
}

export async function updateLead(id: number, input: LeadInput) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from crm_leads where id = $1`, [id]);
    if (existing.length === 0) throw new CrmLeadNotFoundError(id);

    const { rows } = await client.query(
      `update crm_leads set
         lead_name = $2, company = $3, phone = $4, email = $5, customer_id = $6,
         status = $7, estimated_value = $8, source = $9, notes = $10, updated_at = now()
       where id = $1
       returning *`,
      [
        id, input.leadName, input.company ?? null, input.phone ?? null, input.email ?? null,
        input.customerId ?? null, input.status, input.estimatedValue ?? null, input.source ?? null, input.notes ?? null,
      ],
    );
    await writeAudit(client, { userId: input.userId, action: "update", module: "crm_leads", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
}

// ------------------------------------------------------------
// FOLLOW-UPS
// ------------------------------------------------------------

export async function listFollowups() {
  const { rows } = await query(`select * from crm_followups order by due_date asc`);
  return rows;
}

export type FollowupInput = {
  leadId: number;
  dueDate: string;
  followupType: string;
  notes?: string | null;
  status: string;
  userId: number | null;
};

export async function createFollowup(input: FollowupInput) {
  return withTransaction(async (client) => {
    const { rows: leadRows } = await client.query(`select id from crm_leads where id = $1`, [input.leadId]);
    if (leadRows.length === 0) throw new CrmLeadNotFoundError(input.leadId);

    const { rows } = await client.query(
      `insert into crm_followups (lead_id, due_date, followup_type, notes, status, created_by)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [input.leadId, input.dueDate, input.followupType, input.notes ?? null, input.status, input.userId],
    );
    const followup = rows[0];
    await writeAudit(client, { userId: input.userId, action: "create", module: "crm_followups", recordId: followup.id, newValue: { due_date: input.dueDate } });
    return followup;
  });
}

export async function updateFollowup(id: number, input: FollowupInput) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from crm_followups where id = $1`, [id]);
    if (existing.length === 0) throw new CrmFollowupNotFoundError(id);

    const { rows } = await client.query(
      `update crm_followups set lead_id = $2, due_date = $3, followup_type = $4, notes = $5, status = $6, updated_at = now()
       where id = $1
       returning *`,
      [id, input.leadId, input.dueDate, input.followupType, input.notes ?? null, input.status],
    );
    await writeAudit(client, { userId: input.userId, action: "update", module: "crm_followups", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
}

// ------------------------------------------------------------
// ACTIVITIES
// ------------------------------------------------------------

export async function listActivities() {
  const { rows } = await query(`select * from crm_activities order by activity_date desc`);
  return rows;
}

export type ActivityInput = {
  leadId: number;
  activityDate: string;
  activityType: string;
  summary: string;
  userId: number | null;
};

export async function createActivity(input: ActivityInput) {
  return withTransaction(async (client) => {
    const { rows: leadRows } = await client.query(`select id from crm_leads where id = $1`, [input.leadId]);
    if (leadRows.length === 0) throw new CrmLeadNotFoundError(input.leadId);

    const { rows } = await client.query(
      `insert into crm_activities (lead_id, activity_date, activity_type, summary, created_by)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [input.leadId, input.activityDate, input.activityType, input.summary, input.userId],
    );
    const activity = rows[0];
    await writeAudit(client, { userId: input.userId, action: "create", module: "crm_activities", recordId: activity.id, newValue: { activity_date: input.activityDate } });
    return activity;
  });
}

export async function updateActivity(id: number, input: ActivityInput) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(`select * from crm_activities where id = $1`, [id]);
    if (existing.length === 0) throw new CrmActivityNotFoundError(id);

    const { rows } = await client.query(
      `update crm_activities set lead_id = $2, activity_date = $3, activity_type = $4, summary = $5
       where id = $1
       returning *`,
      [id, input.leadId, input.activityDate, input.activityType, input.summary],
    );
    await writeAudit(client, { userId: input.userId, action: "update", module: "crm_activities", recordId: id, oldValue: existing[0], newValue: rows[0] });
    return rows[0];
  });
}
