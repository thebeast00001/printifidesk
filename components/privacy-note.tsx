import Link from "next/link";
import { ShieldCheck } from "lucide-react";

/**
 * Claims only what the code actually does. Automatic purging isn't built yet,
 * so this promises manual deletion — which is — rather than a retention window
 * nothing enforces.
 */
export function PrivacyNote() {
  return (
    <p
      data-anim="privacy"
      className="mt-10 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center text-[12px] leading-relaxed text-muted"
    >
      <ShieldCheck size={13} strokeWidth={2.2} className="shrink-0" />
      Your files are private to your account and never downloadable by the operator.
      <Link href="/settings" className="font-semibold text-ink-soft underline underline-offset-2">
        Delete them any time
      </Link>
      .
    </p>
  );
}
