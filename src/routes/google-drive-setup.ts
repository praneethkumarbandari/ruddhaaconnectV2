import { Router, type Request, type Response } from "express";
import { getAuthUrl, exchangeCodeForTokens } from "../lib/google-drive.ts";
import { asyncHandler } from "../lib/async-handler.ts";

/**
 * ONE-TIME SETUP — same shared-secret pattern as src/routes/setup.ts.
 * Not permission-gated by employee login (this runs before you'd even
 * have the refresh token needed for anything else to work), gated
 * instead by SETUP_TOKEN, same as the tenant bootstrap/onboarding
 * endpoints.
 *
 * Flow, entirely in a browser, no command line:
 *   1. Visit /api/google-drive/connect?token=YOUR_SETUP_TOKEN
 *   2. You'll be redirected to Google's real consent screen — log in
 *      with the Google account whose Drive you want to use (your 5TB
 *      one), approve access.
 *   3. Google redirects back to /callback, which exchanges the
 *      one-time code for a refresh token and displays it ONCE.
 *   4. Copy that refresh token into Netlify's environment variables
 *      as GOOGLE_REFRESH_TOKEN, then redeploy.
 *
 * The refresh token is shown once, in the page, and never stored by
 * this app anywhere — if you lose it before saving it to Netlify,
 * just run this flow again (prompt=consent forces Google to issue a
 * fresh one every time).
 */
const router = Router();

function requireSetupToken(req: Request, res: Response): boolean {
  const setupToken = process.env.SETUP_TOKEN;
  if (!setupToken) {
    res.status(500).send("SETUP_TOKEN is not set on the server.");
    return false;
  }
  if (req.query.token !== setupToken) {
    res.status(403).send("Invalid or missing setup token.");
    return false;
  }
  return true;
}

router.get("/connect", asyncHandler(async (req: Request, res: Response) => {
  if (!requireSetupToken(req, res)) return;
  const url = getAuthUrl();
  return res.redirect(url);
}));

router.get("/callback", asyncHandler(async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    return res.status(400).send("No authorization code received from Google.");
  }
  const tokens = await exchangeCodeForTokens(code);
  if (!tokens.refresh_token) {
    return res.status(500).send(
      "Google did not return a refresh token. This usually means this account already " +
      "authorized this app before without prompt=consent forcing a new one — try revoking " +
      "access at myaccount.google.com/permissions and running /connect again.",
    );
  }
  return res.status(200).send(`
    <html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;">
      <h2>Google Drive connected</h2>
      <p>Copy the value below and save it in Netlify as an environment variable named
      <code>GOOGLE_REFRESH_TOKEN</code>, then trigger a redeploy. This is shown once —
      it is not stored anywhere by this app.</p>
      <textarea readonly style="width:100%;height:80px;font-family:monospace;padding:10px;">${tokens.refresh_token}</textarea>
      <p>You'll also need these three set already (from Google Cloud Console):</p>
      <ul>
        <li><code>GOOGLE_CLIENT_ID</code></li>
        <li><code>GOOGLE_CLIENT_SECRET</code></li>
        <li><code>GOOGLE_REDIRECT_URI</code> (this exact callback URL)</li>
        <li><code>GOOGLE_DRIVE_ROOT_FOLDER_ID</code> (create one folder in your Drive, copy its id from the URL)</li>
      </ul>
    </body></html>
  `);
}));

export default router;
