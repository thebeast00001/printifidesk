"use client";

import { useEffect } from "react";
import { useAuth, useUser } from "@clerk/nextjs";
import { registerClerkBridge, syncProfile } from "@/lib/supabase/client";
import { useProfileSync } from "@/lib/profile-sync";

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

  // Register synchronously too, so the very first render already has a token
  // getter — otherwise the first query races ahead of this effect.
  registerClerkBridge({ getToken: () => getToken(), userId: userId ?? null, loaded: isLoaded });

  useEffect(() => {
    registerClerkBridge({ getToken: () => getToken(), userId: userId ?? null, loaded: isLoaded });

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
  }, [getToken, userId, isLoaded, user, setSyncError]);

  return null;
}
