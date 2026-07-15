import { Router, type Request, type Response } from "express";
import { pool, withTransaction } from "../db/pool.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requireCustomerAuth } from "../middleware/customer-auth.ts";
import { authLoginLimiter, otpLimiter } from "../middleware/rate-limit.ts";
import {
  signCustomerToken,
  signResetToken,
  verifyResetToken,
  hashPassword,
  verifyPassword,
  generateOtp,
  hashOtp,
  verifyOtp,
  fingerprintOtpHash,
} from "../lib/customer-auth.ts";
import { resolveSchemaFromRequest } from "../lib/schema-resolver.ts";

/**
 * Replaces the old customer-login.html flow that queried Supabase
 * directly from the browser and compared/stored plaintext passwords
 * (see the Deployment Readiness Audit — this was flagged as a live
 * credential-exposure blocker). Every write and every credential
 * comparison now happens here, server-side, with bcrypt.
 *
 * A deliberately generic error message ("Invalid email or password.")
 * is used for both "no such customer" and "wrong password" so this
 * endpoint doesn't confirm which emails have portal accounts.
 */

const router = Router();

router.post("/login", authLoginLimiter, asyncHandler(async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required." });
  }

  const schemaName = resolveSchemaFromRequest(req);
  const { rows } = await pool.query(
    `select id, customer_name, email, password_hash, is_active
     from ${schemaName}.customers
     where lower(email) = $1`,
    [email],
  );

  if (rows.length === 0 || !rows[0].password_hash) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const customer = rows[0];
  const valid = await verifyPassword(password, customer.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  if (!customer.is_active) {
    return res.status(403).json({ error: "Account is inactive. Please contact support." });
  }

  const token = signCustomerToken({ customerId: Number(customer.id), email: customer.email, schemaName });
  return res.status(200).json({
    token,
    customer: { id: customer.id, customerName: customer.customer_name, email: customer.email },
  });
}));

/**
 * Step 1 of password reset: generate an OTP, store only its bcrypt
 * hash + a 10-minute expiry, and return the plain OTP once to the
 * caller so the existing client-side EmailJS call can send it — the
 * OTP itself was already generated client-side in the old flow, so
 * this preserves the same email-delivery behavior while removing the
 * plaintext OTP (and the customer row's password) from ever being
 * stored insecurely or returned as anything other than this one
 * short-lived value.
 *
 * Always returns 200 with a generic message, whether or not the email
 * exists, so this endpoint can't be used to enumerate registered
 * customer emails.
 */
router.post("/request-otp", otpLimiter, asyncHandler(async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: "email is required." });
  }

  const schemaName = resolveSchemaFromRequest(req);
  const { rows } = await pool.query(
    `select id, customer_name, email from ${schemaName}.customers where lower(email) = $1`,
    [email],
  );

  if (rows.length === 0) {
    // Same response shape as the success path — no enumeration signal.
    return res.status(200).json({ message: "If that email is registered, an OTP has been sent." });
  }

  const customer = rows[0];
  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  const expiry = new Date(Date.now() + 10 * 60 * 1000);

  await pool.query(
    `update ${schemaName}.customers set otp_hash = $1, otp_expiry = $2 where id = $3`,
    [otpHash, expiry, customer.id],
  );

  return res.status(200).json({
    message: "If that email is registered, an OTP has been sent.",
    // Consumed immediately by the frontend to trigger the EmailJS send —
    // never logged, never stored anywhere but this one response.
    otp,
    customerName: customer.customer_name,
  });
}));

router.post("/verify-otp", otpLimiter, asyncHandler(async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const otp = String(req.body?.otp ?? "").trim();
  if (!email || !otp) {
    return res.status(400).json({ error: "email and otp are required." });
  }

  const schemaName = resolveSchemaFromRequest(req);
  const { rows } = await pool.query(
    `select id, email, otp_hash, otp_expiry from ${schemaName}.customers where lower(email) = $1`,
    [email],
  );

  if (rows.length === 0 || !rows[0].otp_hash || !rows[0].otp_expiry) {
    return res.status(401).json({ error: "Invalid or expired OTP." });
  }

  const customer = rows[0];
  if (new Date() > new Date(customer.otp_expiry)) {
    return res.status(401).json({ error: "Invalid or expired OTP." });
  }

  const valid = await verifyOtp(otp, customer.otp_hash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid or expired OTP." });
  }

  const resetToken = signResetToken({
    customerId: Number(customer.id),
    email: customer.email,
    otpFingerprint: fingerprintOtpHash(customer.otp_hash),
    schemaName,
  });
  return res.status(200).json({ resetToken });
}));

router.post("/reset-password", otpLimiter, asyncHandler(async (req: Request, res: Response) => {
  const { resetToken, newPassword } = req.body ?? {};
  if (!resetToken || !newPassword) {
    return res.status(400).json({ error: "resetToken and newPassword are required." });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  let payload;
  try {
    payload = verifyResetToken(resetToken);
  } catch {
    return res.status(401).json({ error: "Invalid or expired reset session. Please request a new OTP." });
  }

  const passwordHash = await hashPassword(newPassword);

  const result = await withTransaction(async (client) => {
    // Lock the row and re-check the fingerprint inside the transaction
    // so two concurrent reset-password calls with the same token can't
    // both pass the check before either one clears otp_hash.
    const { rows: current } = await client.query(
      `select otp_hash from ${payload.schemaName}.customers where id = $1 for update`,
      [payload.customerId],
    );
    if (current.length === 0) {
      return { ok: false as const };
    }
    if (fingerprintOtpHash(current[0].otp_hash) !== payload.otpFingerprint) {
      // Either already used (otp_hash was nulled by an earlier
      // reset-password call with this same token) or superseded (a
      // newer OTP was requested since this token was issued).
      return { ok: false as const };
    }

    // Clearing otp_hash/otp_expiry means the OTP that produced this
    // resetToken can't be reused even within its own 10-minute window —
    // one OTP, one reset.
    await client.query(
      `update ${payload.schemaName}.customers set password_hash = $1, otp_hash = null, otp_expiry = null where id = $2`,
      [passwordHash, payload.customerId],
    );
    return { ok: true as const };
  });

  if (!result.ok) {
    return res.status(401).json({ error: "This reset link has already been used or is no longer valid. Please request a new OTP." });
  }

  return res.status(200).json({ message: "Password reset successful. Please log in with your new password." });
}));

/**
 * Safe replacement for reading the whole localStorage "loggedCustomer"
 * blob (which previously included the plaintext password). Returns
 * only display-safe fields.
 */
router.get("/me", requireCustomerAuth, asyncHandler(async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `select id, customer_name, email, is_active from ${req.customer!.schemaName}.customers where id = $1`,
    [req.customer!.customerId],
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: "Customer not found." });
  }
  const c = rows[0];
  return res.status(200).json({ id: c.id, customerName: c.customer_name, email: c.email, isActive: c.is_active });
}));

export default router;
