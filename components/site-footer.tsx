import Link from "next/link";
import { Mail, MessageCircle } from "lucide-react";
import { SUPPORT_EMAIL, supportWhatsAppUrl } from "@/components/support-line";
import { BRAND, DESK_URL, POLICIES_UPDATED_LABEL, SITE_HOST } from "@/lib/seo";

/**
 * The foot of the student site: every page there is, in plain columns, with
 * the name and the address written out. It does two jobs. A person reaches
 * the bottom of the home page and finds the refund policy, the terms, where
 * to write. A search engine finds the site's structure — one link to each
 * public page, from the page it ranks — which is what turns a single result
 * into a result with its pages listed underneath.
 *
 * Only real destinations: every link is a route in this app, and the support
 * channels appear only when the environment sets them.
 */

type FooterLink = { href: string; label: string; external?: boolean };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Print",
    links: [
      { href: "/", label: "Send something to print" },
      { href: "/orders", label: "Your orders" },
      { href: "/profile", label: "Your profile" },
      { href: "/settings", label: "Settings & your files" },
    ],
  },
  {
    title: "Print desks",
    links: [
      { href: "/join", label: "Run a desk on Printifi" },
      { href: "/desk-terms", label: "Terms for print desks" },
      { href: `${DESK_URL}/sign-in`, label: "Desk sign-in", external: true },
    ],
  },
  {
    title: "Policies",
    links: [
      { href: "/terms", label: "Terms of service" },
      { href: "/privacy", label: "Privacy policy" },
      { href: "/refunds", label: "Refund policy" },
    ],
  },
];

export function SiteFooter() {
  const wa = supportWhatsAppUrl();
  const year = new Date().getFullYear();
  return (
    <footer data-anim="footer" className="mt-14 border-t border-line pt-8 pb-[max(24px,env(safe-area-inset-bottom))]">
      <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="col-span-2 sm:col-span-1">
          <p className="font-heading m-0 text-[18px] font-extrabold tracking-[-0.02em] text-ink">{BRAND}</p>
          <p className="m-0 mt-1.5 max-w-[30ch] text-[12.5px] leading-relaxed text-muted">
            Upload from your phone, pay with UPI or at the counter, collect a printed set.
          </p>
          <p className="m-0 mt-3 font-mono text-[11.5px] text-muted">{SITE_HOST}</p>
          {(wa || SUPPORT_EMAIL) && (
            <div className="mt-3 flex flex-col gap-1.5">
              {wa && (
                <a
                  href={wa}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-soft underline-offset-2 hover:underline"
                >
                  <MessageCircle size={13} strokeWidth={2.4} />
                  WhatsApp support
                </a>
              )}
              {SUPPORT_EMAIL && (
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-soft underline-offset-2 hover:underline"
                >
                  <Mail size={13} strokeWidth={2.4} />
                  {SUPPORT_EMAIL}
                </a>
              )}
            </div>
          )}
        </div>

        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <p className="label-caps m-0 mb-2.5">{column.title}</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {column.links.map((link) => (
                <li key={link.href}>
                  {link.external ? (
                    <a href={link.href} className="text-[13px] text-ink-soft underline-offset-2 hover:underline">
                      {link.label}
                    </a>
                  ) : (
                    <Link href={link.href} className="text-[13px] text-ink-soft underline-offset-2 hover:underline">
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <p className="m-0 mt-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line pt-4 text-[11.5px] text-muted">
        <span>
          © {year} {BRAND} · {SITE_HOST}
        </span>
        <span>Policies last updated {POLICIES_UPDATED_LABEL}</span>
      </p>
    </footer>
  );
}
