"use client";

import { SignInButton } from "@clerk/nextjs";
import { LogIn } from "lucide-react";
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
      <SignInButton mode="modal">
        <button className="mt-4 inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-semibold text-paper">
          <LogIn size={14} strokeWidth={2.2} />
          Sign in
        </button>
      </SignInButton>
    </div>
  );
}
