import type { PgClient } from "../db/pool.ts";
import { pool, query } from "../db/pool.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { logProjectActivity } from "./project-activity-log.ts";

export class DocumentNotFoundError extends Error {
  constructor(id: number) { super(`Document ${id} not found.`); this.name = "DocumentNotFoundError"; }
}

async function assertProjectExists(client: PgClient, projectId: number) {
  const { rows } = await client.query(`select id from projects where id = $1`, [projectId]);
  if (rows.length === 0) throw new ProjectNotFoundError(projectId);
}

/**
 * Document Service. Metadata only — fileName + storagePath (an
 * external reference the caller already uploaded to, e.g. object
 * storage). This backend never receives or stores a file body for
 * project documents; that's a deliberate scope boundary, not an
 * oversight (mirrors how Bank Import treats uploaded files as
 * transient input, never persisted as a blob).
 */
export async function addDocument(
  client: PgClient,
  projectId: number,
  fileName: string,
  storagePath: string,
  uploadedBy: number | null,
) {
  await assertProjectExists(client, projectId);
  const { rows } = await client.query(
    `insert into project_documents (project_id, file_name, storage_path, uploaded_by)
     values ($1, $2, $3, $4)
     returning *`,
    [projectId, fileName, storagePath, uploadedBy],
  );
  await logProjectActivity(client, projectId, uploadedBy, "document_added", { fileName });
  return rows[0];
}

export async function removeDocument(client: PgClient, documentId: number, performedBy: number | null) {
  const { rows } = await client.query(`delete from project_documents where id = $1 returning *`, [documentId]);
  if (rows.length === 0) throw new DocumentNotFoundError(documentId);
  await logProjectActivity(client, rows[0].project_id, performedBy, "document_removed", { fileName: rows[0].file_name });
  return rows[0];
}

export async function listDocuments(projectId: number) {
  const { rows } = await query(
    `select pd.*, e.employee_name as uploaded_by_name
     from project_documents pd
     left join employees e on e.id = pd.uploaded_by
     where pd.project_id = $1
     order by pd.uploaded_at desc`,
    [projectId],
  );
  return rows;
}

/**
 * Note Service. Append-only by convention: intentionally no update or
 * delete function exists here at all — not merely "not wired to a
 * route." A note, once written, is a permanent part of the project's
 * record.
 */
export async function addNote(client: PgClient, projectId: number, authorId: number | null, note: string) {
  await assertProjectExists(client, projectId);
  const { rows } = await client.query(
    `insert into project_notes (project_id, author_id, note) values ($1, $2, $3) returning *`,
    [projectId, authorId, note],
  );
  await logProjectActivity(client, projectId, authorId, "note_added", {});
  return rows[0];
}

export async function listNotes(projectId: number) {
  const { rows } = await query(
    `select pn.*, e.employee_name as author_name
     from project_notes pn
     left join employees e on e.id = pn.author_id
     where pn.project_id = $1
     order by pn.created_at desc`,
    [projectId],
  );
  return rows;
}
