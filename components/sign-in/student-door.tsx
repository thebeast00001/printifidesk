"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";
import { sameOriginPath } from "@/lib/surface";
import Link from "next/link";
import { GoogleSignIn } from "./google-button";

/**
 * The student's door: Google, and nothing else to read.
 * Reached when a protected page needs an account, with `next` set to it.
 */
export function StudentDoor({ next }: { next: string }) {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useAuth();
  const target = sameOriginPath(next, "/");

  useEffect(() => {
    if (isLoaded && isSignedIn) router.replace(target);
  }, [isLoaded, isSignedIn, router, target]);

  return (
    <div className="mx-auto w-full max-w-[420px] rounded-[24px] border border-line bg-surface p-5 text-center shadow-card lg:p-6">
      {!isLoaded || isSignedIn ? (
        <p className="m-0 flex items-center justify-center gap-2 text-[13px] text-muted">
          <Loader2 size={15} className="animate-spin" />
          One moment…
        </p>
      ) : (
        <>
          <p className="label-caps m-0">Printify</p>
          <h2 className="font-heading m-0 mt-1 text-[24px] font-bold">Sign in</h2>
          <p className="mx-auto m-0 mt-1.5 max-w-[36ch] text-[12.5px] leading-relaxed text-muted">
            Your orders, files and tokens are tied to your Google account. One tap, no password.
          </p>
          <div className="mt-5">
            <GoogleSignIn next={target} className="w-full" />
          </div>
          <p className="m-0 mt-4 text-[11px] leading-relaxed text-muted">
            By continuing you agree to the{" "}
            <Link href="/terms" className="underline-offset-2 hover:underline">terms</Link> and the{" "}
            <Link href="/privacy" className="underline-offset-2 hover:underline">privacy policy</Link>.
          </p>
        </>
      )}
    </div>
  );
}
