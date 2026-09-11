/**
 * Reads the expiry out of a JWT without verifying it.
 *
 * Verification is Supabase's job — this only needs to know *when* a token the
 * browser already holds will stop working, so it can be replaced before then.
 * Anything malformed reads as "unknown", never as "valid".
 */
export function jwtExpiresAt(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/** Milliseconds until the token lapses; negative once it has. Null if unknowable. */
export function jwtMsRemaining(token: string, now = Date.now()): number | null {
  const at = jwtExpiresAt(token);
  return at === null ? null : at - now;
}

function base64UrlDecode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  // `atob` exists in browsers and Node 16+, which covers everywhere this runs.
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
