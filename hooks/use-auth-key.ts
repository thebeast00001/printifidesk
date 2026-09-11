"use client";

import { useAuth } from "@clerk/nextjs";

/**
 * A dependency that changes whenever Clerk's auth state does.
 *
 * The Supabase client reads its token from a module-level bridge, which React
 * can't observe. Without this, a query that ran while Clerk was still loading
 * would never re-run once a user appeared, and the UI would sit on "Starting
 * up…" forever. Every data hook takes this as a dependency.
 */
export function useAuthKey(): string {
  const { isLoaded, userId } = useAuth();
  return `${isLoaded ? "loaded" : "loading"}:${userId ?? "anon"}`;
}
