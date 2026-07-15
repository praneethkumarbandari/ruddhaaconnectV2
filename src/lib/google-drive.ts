import { google } from "googleapis";
import { Readable } from "stream";
import { pool } from "../db/pool.ts";

/**
 * Real file storage backed by one shared Google Drive account (5TB
 * plan) instead of Google Drive links pasted in by hand. Uses OAuth2
 * with a long-lived refresh token — set up once via
 * src/routes/google-drive-setup.ts, never touched again unless the
 * authorization is revoked.
 *
 * Env vars required:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — from Google Cloud Console
 *   GOOGLE_REDIRECT_URI — e.g. https://your-site.netlify.app/api/google-drive/callback
 *   GOOGLE_REFRESH_TOKEN — obtained once via the one-time setup flow
 *   GOOGLE_DRIVE_ROOT_FOLDER_ID — the Drive folder (in that account)
 *     everything lives under; create one folder in Drive, open it,
 *     copy the id from the URL.
 */
function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must all be set.");
  }
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (refreshToken) {
    client.setCredentials({ refresh_token: refreshToken });
  }
  return client;
}

function getDriveClient() {
  const auth = getOAuthClient();
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("GOOGLE_REFRESH_TOKEN is not set — run the one-time setup at /api/google-drive/connect first.");
  }
  return google.drive({ version: "v3", auth });
}

export function getAuthUrl(): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token to come back even on re-auth
    scope: ["https://www.googleapis.com/auth/drive.file"],
  });
}

export async function exchangeCodeForTokens(code: string) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens; // caller displays tokens.refresh_token once — save it as GOOGLE_REFRESH_TOKEN
}

/**
 * Gets (or creates, once) the Drive subfolder for this company, under
 * the shared root folder. Reused on every subsequent upload for that
 * company — never re-created, never shared across companies.
 *
 * FIX (architecture pivot): keyed on schemaName (matched against
 * tenants.tenant_code, which by convention is the same string as the
 * company's schema name) instead of a numeric tenant id — the
 * `tenants` table still exists as a lightweight cross-cutting
 * metadata registry (this Drive folder mapping is exactly that kind
 * of thing), it just no longer doubles as an isolation mechanism the
 * way it did under the RLS model.
 */
async function getOrCreateTenantFolder(schemaName: string): Promise<string> {
  const { rows } = await pool.query(`select drive_folder_id from tenants where tenant_code = $1`, [schemaName]);
  if (rows.length === 0) throw new Error(`No tenant registry entry found for schema "${schemaName}".`);
  if (rows[0].drive_folder_id) return rows[0].drive_folder_id;

  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID is not set.");

  const drive = getDriveClient();
  const folder = await drive.files.create({
    requestBody: {
      name: `tenant-${schemaName}`,
      mimeType: "application/vnd.google-apps.folder",
      parents: [rootFolderId],
    },
    fields: "id",
  });
  const folderId = folder.data.id!;
  await pool.query(`update tenants set drive_folder_id = $1 where tenant_code = $2`, [folderId, schemaName]);
  return folderId;
}

export async function uploadFile(params: {
  schemaName: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<{ driveFileId: string }> {
  const folderId = await getOrCreateTenantFolder(params.schemaName);
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: { name: params.fileName, parents: [folderId] },
    media: { mimeType: params.mimeType, body: Readable.from(params.buffer) },
    fields: "id",
  });
  return { driveFileId: res.data.id! };
}

/**
 * Downloads a file — but ONLY after the caller has already confirmed
 * (via a real DB query, e.g. "does this employee_documents row with
 * this drive file id belong to the requesting tenant") that this
 * download is allowed. This function has no idea what a tenant is;
 * it just fetches whatever file id it's given. The tenant check MUST
 * happen before calling this, in the route handler — never trust a
 * Drive file id alone as proof of authorization.
 */
export async function downloadFile(driveFileId: string): Promise<{ stream: NodeJS.ReadableStream; mimeType: string }> {
  const drive = getDriveClient();
  const meta = await drive.files.get({ fileId: driveFileId, fields: "mimeType" });
  const res = await drive.files.get({ fileId: driveFileId, alt: "media" }, { responseType: "stream" });
  return { stream: res.data as unknown as NodeJS.ReadableStream, mimeType: meta.data.mimeType || "application/octet-stream" };
}

export async function deleteFile(driveFileId: string): Promise<void> {
  const drive = getDriveClient();
  await drive.files.delete({ fileId: driveFileId });
}
