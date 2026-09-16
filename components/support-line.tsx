import { MessageCircle, Mail } from "lucide-react";
import Link from "next/link";

/**
 * How to reach Printify, from the desk's footer and the legal pages. Only
 * a channel that is actually set up is printed: a WhatsApp number from
 * NEXT_PUBLIC_SUPPORT_WHATSAPP (digits, country code first — "9198…"),
 * an email from NEXT_PUBLIC_SUPPORT_EMAIL. Neither set, the line is the
 * legal links alone rather than a mailbox nobody reads.
 */
export const SUPPORT_WHATSAPP = (process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP ?? "").replace(/\D/g, "") || null;
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || null;

export function supportWhatsAppUrl(text?: string): string | null {
  if (!SUPPORT_WHATSAPP) return null;
  return `https://wa.me/${SUPPORT_WHATSAPP}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function SupportLine({ desk, deskName }: { desk?: boolean; deskName?: string }) {
  const wa = supportWhatsAppUrl(desk && deskName ? `Hi Printify — ${deskName} here.` : undefined);
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
      {wa && (
        <a href={wa} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 font-semibold text-ink-soft underline-offset-2 hover:underline">
          <MessageCircle size={12} strokeWidth={2.4} />
          WhatsApp support
        </a>
      )}
      {SUPPORT_EMAIL && (
        <a href={`mailto:${SUPPORT_EMAIL}`} className="flex items-center gap-1 font-semibold text-ink-soft underline-offset-2 hover:underline">
          <Mail size={12} strokeWidth={2.4} />
          {SUPPORT_EMAIL}
        </a>
      )}
      {desk ? (
        <Link href="/desk-terms" className="underline-offset-2 hover:underline">Terms for desks</Link>
      ) : (
        <Link href="/refunds" className="underline-offset-2 hover:underline">Refund policy</Link>
      )}
      <Link href="/privacy" className="underline-offset-2 hover:underline">Privacy</Link>
    </p>
  );
}
