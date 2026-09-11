"use client";

import { usePathname } from "next/navigation";
import { GoogleSignIn } from "./sign-in/google-button";
import { cn } from "@/lib/utils";

/**
 * Signing in is a real requirement, not a wall in front of a demo — your files
 * and orders are rows keyed to your account, and there's nothing to show
 * without one.
 */
export function SignedOutNotice({
  title = "Sign in to continue",
  body,
  className,
}: {
  title?: string;
  body: string;
  className?: string;
}) {
  const pathname = usePathname();
  return (
    <div
      className={cn(
        "rounded-[20px] border border-line bg-surface p-6 text-center shadow-card",
        className,
      )}
    >
      <p className="m-0 text-[14px] font-semibold tracking-[-0.01em]">{title}</p>
      <p className="mx-auto m-0 mt-1.5 max-w-[42ch] text-[12.5px] leading-relaxed text-muted">
        {body}
      </p>
      <div className="mt-4">
        <GoogleSignIn next={pathname} />
      </div>
    </div>
  );
}
