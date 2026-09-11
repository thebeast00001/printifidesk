"use client";

import { create } from "zustand";

/**
 * Whether mirroring the Clerk identity into `profiles` succeeded.
 *
 * Kept in a store so the failure can be shown where someone will actually look
 * for it — the Connection panel on /profile — rather than only in the console.
 */
export const useProfileSync = create<{
  error: string | null;
  setError: (error: string | null) => void;
}>((set) => ({
  error: null,
  setError: (error) => set({ error }),
}));
