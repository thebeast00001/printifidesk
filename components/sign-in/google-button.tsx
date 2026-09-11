"use client";

import { useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";
import { sameOriginPath } from "@/lib/surface";
import { cn } from "@/lib/utils";

/**
 * The student's whole sign-in: one Google button.
 *
 * A custom flow rather than Clerk's modal, because the modal shows every
 * method the instance has enabled — and the desk's email-and-password door
 * would show up on the student side too. The redirect lands on
 * `/sso-callback`, where Clerk finishes the exchange and sends the person to
 * `next`. A Google account that has never signed in before is created on
 * the way through; that's Clerk's transfer step, handled by the callback.
 */
export function useGoogleSignIn(next = "/") {
  const clerk = useClerk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!clerk.loaded || !clerk.client) return;
    setBusy(true);
    setError(null);
    try {
      await clerk.client.signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectUrlComplete: sameOriginPath(next, "/"),
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Couldn't start Google sign-in.");
    }
  }

  return { go, busy, error, ready: clerk.loaded };
}

export function GoogleSignIn({
  next = "/",
  children,
  className,
}: {
  /** Where to land afterwards. Only a same-origin path is honoured. */
  next?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const { go, busy, error, ready } = useGoogleSignIn(next);

  return (
    <>
      <button
        onClick={() => void go()}
        disabled={busy || !ready}
        className={cn(
          "inline-flex h-11 items-center justify-center gap-2.5 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-60",
          className,
        )}
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <GoogleMark />}
        {children ?? "Continue with Google"}
      </button>
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </>
  );
}

/** Google's "G", drawn inline so it needs no image request. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.7-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1C3.3 21.3 7.3 24 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3c-.5-1.5-.5-3.1 0-4.6V6.6H1.3c-1.7 3.4-1.7 7.4 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.7c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.3 0 3.3 2.7 1.3 6.6l4 3.1c.9-2.9 3.6-5 6.7-5z" />
    </svg>
  );
}
