import rateLimit from "express-rate-limit";

/**
 * FIX (found during production-readiness re-audit): none of the auth
 * endpoints had any rate limiting or brute-force protection at all —
 * not employee login, not customer login, and not the customer OTP
 * flow. A 6-digit OTP (1,000,000 possibilities) with a 10-minute
 * expiry and zero throttling is meaningfully brute-forceable; the
 * same is true of password guessing against any known email/username.
 *
 * These limits are intentionally generous for real users (a person
 * mistyping their password 5-10 times is normal) while still cutting
 * off automated guessing long before it becomes a real threat. They
 * key on IP address, which isn't perfect (shared NAT/proxies), but is
 * the standard first line of defense and doesn't require adding new
 * infrastructure (Redis, etc.) for this deployment's scale.
 */

/**
 * FIX (found live in production): this backend runs as a Netlify
 * Function, not a standalone server with a real TCP socket. Express's
 * built-in req.ip relies on that socket (plus the 'trust proxy' hop
 * count) to compute the client's address, and in this serverless
 * context that computation comes back undefined — which made
 * express-rate-limit's default keyGenerator throw
 * ERR_ERL_UNDEFINED_IP_ADDRESS and 500 every single request that hit
 * a rate-limited route, confirmed live.
 *
 * The fix is to read the client IP directly from a header instead of
 * trusting req.ip. Netlify sets x-nf-client-connection-ip itself (not
 * client-suppliable, so it can't be spoofed the way a raw
 * X-Forwarded-For value could be) — that's the primary source here.
 * x-forwarded-for is kept only as a fallback for local/dev testing
 * outside Netlify's infrastructure, where that header won't exist.
 * If neither is present, everyone shares a single 'unknown' bucket —
 * degraded (an attacker sharing that bucket could exhaust it and
 * briefly rate-limit other unidentified traffic too) but never a
 * crash, which is the right trade-off for a rate limiter: fail open
 * to "some throttling for an unidentified caller", never fail closed
 * by throwing and taking the whole request down with it.
 */
function clientIp(req) {
  return (
    req.headers["x-nf-client-connection-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown"
  );
}

export const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { error: "Too many login attempts. Please try again in a few minutes." },
});

/**
 * Tighter limit for OTP request/verify — a 6-digit code is a much
 * smaller search space than a real password, so it needs a stricter
 * ceiling to stay meaningfully unguessable within its validity window.
 */
export const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { error: "Too many attempts. Please wait before trying again." },
});
