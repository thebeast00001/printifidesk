import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Checks a shared secret without leaking how much of it matched.
 *
 * `provided !== secret` returns the moment it finds a differing byte, so the
 * time it takes says how long the correct prefix is. Over enough requests
 * that is a way to recover the secret one character at a time. Comparing
 * fixed-length digests instead takes the same time whatever was sent — and
 * hashing first means two strings of different lengths still compare in
 * constant time, which `timingSafeEqual` on the raw strings would not allow.
 */
export function secretMatches(provided: string | null | undefined, secret: string): boolean {
  if (!provided || !secret) return false;
  const a = digest(provided);
  const b = digest(secret);
  return timingSafeEqual(a, b);
}

function digest(value: string): Buffer {
  // SHA-256 of the value: fixed 32 bytes regardless of input length.
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * The one check both maintenance routes make, in one place, so they can't
 * drift: is the endpoint enabled, and did the caller prove they may use it?
 * Returns a Response to send when they may not, or null when they may.
 *
 * Two ways to prove it: the `x-notify-secret` header (a scheduler you
 * configure), or `Authorization: Bearer …` (what Vercel Cron sends, from its
 * `CRON_SECRET` variable). Either must equal `NOTIFY_WEBHOOK_SECRET`, or the
 * Bearer may equal `CRON_SECRET` if that is set separately.
 */
export function requireSecret(request: Request): Response | null {
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json(
      { ok: false, error: "NOTIFY_WEBHOOK_SECRET is not set, so this endpoint is disabled." },
      { status: 503 },
    );
  }
  const header = request.headers.get("x-notify-secret");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const cron = process.env.CRON_SECRET;
  const ok =
    secretMatches(header, secret) ||
    secretMatches(bearer, secret) ||
    (cron ? secretMatches(bearer, cron) : false);
  if (!ok) {
    return Response.json({ ok: false, error: "Bad or missing secret" }, { status: 401 });
  }
  return null;
}
