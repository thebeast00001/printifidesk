"use client";

import { useCallback, useEffect } from "react";
import { preconnect } from "react-dom";
import { useAuth, useUser } from "@clerk/nextjs";
import { SUPABASE_URL, registerClerkBridge, syncProfile } from "@/lib/supabase/client";
import { useProfileSync } from "@/lib/profile-sync";
import { jwtMsRemaining } from "@/lib/jwt";

/**
 * Hands Clerk's session token to the Supabase client, then mirrors the Clerk
 * identity into `profiles`.
 *
 * Registration happens in an effect that re-runs whenever Clerk's state
 * changes, so a sign-in or sign-out is reflected immediately — including in the
 * plain modules (`lib/orders.ts`, `lib/upload.ts`) that can't use hooks.
 */
export function SupabaseBridge() {
  const { getToken, userId, isLoaded } = useAuth();
  const { user } = useUser();
  const setSyncError = useProfileSync((s) => s.setError);

  /*
   * Clerk tokens live sixty seconds and Supabase's realtime socket re-sends
   * one on every heartbeat. Clerk's cache hands back the same token until it
   * is within about ten seconds of expiry — so a heartbeat at t=49 got the
   * old token and the next, at t=74, came after it had lapsed. The server
   * dropped the channel in between, and the operator saw "reconnecting" for
   * no reason anyone could name.
   *
   * So the token's own `exp` is read, and anything inside the last thirty
   * seconds is swapped for a fresh one. With a twenty-second heartbeat, every
   * token is replaced before it can lapse.
   */
  const freshToken = useCallback(async () => {
    const token = await getToken();
    if (!token) return null;
    const remaining = jwtMsRemaining(token);
    if (remaining !== null && remaining < 30_000) {
      return (await getToken({ skipCache: true })) ?? token;
    }
    return token;
  }, [getToken]);

  // Register synchronously too, so the very first render already has a token
  // getter — otherwise the first query races ahead of this effect.
  registerClerkBridge({ getToken: freshToken, userId: userId ?? null, loaded: isLoaded });

  // Rendered into <head> on the server: the browser opens the connection to
  // the database while it's still parsing, so the first public read (the
  // desk's prices, its wait) spends its round trip on the query alone, not
  // on a DNS lookup and a TLS handshake first. Anonymous, as the fetches are.
  if (SUPABASE_URL) preconnect(SUPABASE_URL, { crossOrigin: "anonymous" });

  useEffect(() => {
    registerClerkBridge({ getToken: freshToken, userId: userId ?? null, loaded: isLoaded });

    if (!isLoaded || !userId || !user) {
      setSyncError(null);
      return;
    }

    void syncProfile({
      userId,
      email: user.primaryEmailAddress?.emailAddress ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      avatarUrl: user.imageUrl ?? null,
    }).then(setSyncError);
  }, [freshToken, userId, isLoaded, user, setSyncError]);

  return null;
}
