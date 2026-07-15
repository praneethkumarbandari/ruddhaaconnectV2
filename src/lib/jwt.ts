import jwt from "jsonwebtoken";

function requireSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set. Refusing to start.");
  }
  return secret;
}

// Resolved once at module load (fails fast at boot), but read through
// a function with a real `string` return type so signToken/verifyToken
// don't inherit the wider `string | undefined` type of the env var.
const SECRET: string = requireSecret();

export type TokenPayload = {
  userId: number;
  username: string;
  role: string;
  schemaName: string;
};

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: "12h" });
}

/**
 * FIX (architecture pivot): tenantId (a numeric id looked up against
 * a shared tenants table) replaced with schemaName (the actual
 * Postgres schema this employee's company's tables live in) — see
 * middleware/tenant-context.ts for why. Tokens signed before this
 * change won't carry schemaName at all and are rejected outright here
 * (not defaulted to "test" or guessed at) — a wrong guess would mean
 * running someone's request against the wrong company's schema
 * entirely, not a cosmetic bug. The 12h expiry means every existing
 * session self-resolves within half a day of deploying this.
 */
export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, SECRET);
  if (
    typeof decoded === "string" ||
    !("userId" in decoded) || !("username" in decoded) || !("role" in decoded) || !("schemaName" in decoded)
  ) {
    throw new Error("Malformed token payload.");
  }
  return {
    userId: Number(decoded.userId),
    username: decoded.username as string,
    role: decoded.role as string,
    schemaName: decoded.schemaName as string,
  };
}
