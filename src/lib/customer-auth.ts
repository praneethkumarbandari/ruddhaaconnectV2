import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";

/**
 * Customer-portal auth, kept deliberately separate from src/lib/jwt.ts
 * (employee auth). Two reasons:
 *
 *   1. The payload shape is different (customerId, not userId/role),
 *      and a `scope: "customer"` field is embedded in every token so
 *      a customer token can never be replayed against an employee
 *      route (requireAuth) or vice versa, even though both currently
 *      share the same JWT_SECRET.
 *   2. This is the fix for a real production bug: the previous
 *      customer-login.html compared plaintext passwords client-side
 *      against a Supabase row and stored the entire row — including
 *      the plaintext password — in localStorage. Everything here
 *      exists to make that impossible: passwords are bcrypt-hashed at
 *      rest, OTPs are bcrypt-hashed at rest, and nothing plaintext
 *      ever leaves the server in a response.
 */

function requireSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set. Refusing to start.");
  }
  return secret;
}

const SECRET: string = requireSecret();

export type CustomerTokenPayload = {
  scope: "customer";
  customerId: number;
  email: string;
  schemaName: string;
};

export type ResetTokenPayload = {
  scope: "customer-reset";
  customerId: number;
  email: string;
  otpFingerprint: string;
  schemaName: string;
};

export function signCustomerToken(payload: Omit<CustomerTokenPayload, "scope">): string {
  return jwt.sign({ ...payload, scope: "customer" }, SECRET, { expiresIn: "12h" });
}

/**
 * FIX (architecture pivot): tenantId (numeric) replaced with
 * schemaName (the actual Postgres schema) — same reasoning as
 * lib/jwt.ts's employee TokenPayload. Tokens issued before this
 * change are rejected outright, not defaulted — self-resolves within
 * the 12h expiry.
 */
export function verifyCustomerToken(token: string): CustomerTokenPayload {
  const decoded = jwt.verify(token, SECRET);
  if (
    typeof decoded === "string" ||
    decoded.scope !== "customer" ||
    !("customerId" in decoded) ||
    !("email" in decoded) ||
    !("schemaName" in decoded)
  ) {
    throw new Error("Malformed or wrong-scope token.");
  }
  return {
    scope: "customer",
    customerId: Number(decoded.customerId),
    email: decoded.email as string,
    schemaName: decoded.schemaName as string,
  };
}

/**
 * Short-lived token issued only after a correct OTP is verified. The
 * reset-password step requires this token instead of re-accepting the
 * OTP, so a stolen/guessed OTP can't be replayed against a later
 * reset call once it's been consumed, and reset-password can't be
 * called at all without having passed OTP verification first — a gap
 * that existed in the old three-step client flow, where each step
 * was an independent, unlinked Supabase call.
 *
 * SECURITY FIX (found via live testing against a real database, not
 * just reading the code): a JWT is stateless by nature, so the token
 * alone was replayable — a second reset-password call with the same
 * token, still within its 10-minute expiry, silently succeeded again
 * even after the password had already been changed once. `otpFingerprint`
 * ties the token to the specific `otp_hash` value it was issued
 * against. reset-password re-fetches the customer's CURRENT otp_hash
 * and compares its fingerprint to this one — the moment reset-password
 * succeeds it nulls otp_hash (making every subsequent replay attempt
 * fail the fingerprint check), and requesting a fresh OTP overwrites
 * otp_hash too, independently invalidating any older token.
 */
export function signResetToken(payload: Omit<ResetTokenPayload, "scope">): string {
  return jwt.sign({ ...payload, scope: "customer-reset" }, SECRET, { expiresIn: "10m" });
}

export function verifyResetToken(token: string): ResetTokenPayload {
  const decoded = jwt.verify(token, SECRET);
  if (
    typeof decoded === "string" ||
    decoded.scope !== "customer-reset" ||
    !("customerId" in decoded) ||
    !("email" in decoded) ||
    !("otpFingerprint" in decoded) ||
    !("schemaName" in decoded)
  ) {
    throw new Error("Malformed or wrong-scope token.");
  }
  return {
    scope: "customer-reset",
    customerId: Number(decoded.customerId),
    email: decoded.email as string,
    otpFingerprint: decoded.otpFingerprint as string,
    schemaName: decoded.schemaName as string,
  };
}

export function fingerprintOtpHash(otpHash: string | null): string {
  // Not a security boundary in itself (just a short, comparable digest
  // embedded in a token the client holds) — the actual security comes
  // from otp_hash changing (or being nulled) server-side after use.
  return createHash("sha256").update(otpHash ?? "").digest("hex");
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function generateOtp(): string {
  // 6-digit numeric OTP, matching the digit count the existing EmailJS
  // template already expects — only the storage/verification path
  // changes, not what the customer receives.
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, 10);
}

export async function verifyOtp(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}
