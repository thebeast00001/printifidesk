import Link from "next/link";
import { ShieldCheck } from "lucide-react";

/**
 * Claims only what the database enforces: the file is the student's own row,
 * the desk it was ordered from can open it only while the order is live
 * (claim_document_access records each open; the link lasts five minutes),
 * it is purged six hours after collection (0011's trigger, the purge route),
 * and deletion is a button on /settings. Not "never downloadable": the desk
 * opens a real file in a real tab, and a browser can save what it shows.
 */
export function PrivacyNote() {
  return (
    <p
      data-anim="privacy"
      className="mt-10 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center text-[12px] leading-relaxed text-muted"
    >
      <ShieldCheck size={13} strokeWidth={2.2} className="shrink-0" />
      Your files are private to your account. Only the desk you order from can open them, only while the job is
      live, and every open is recorded.{" "}
      <Link href="/settings" className="font-semibold text-ink-soft underline underline-offset-2">
        Delete them any time
      </Link>
      .
    </p>
  );
}
