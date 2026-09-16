import { Palette, ScanLine, Ticket, Upload } from "lucide-react";
import { BRAND } from "@/lib/seo";

/**
 * What the product does, in three steps and one sentence each — the part of
 * the home page that reads the same signed in or out, so a first visitor
 * (or a search engine) learns what the site is without an account.
 *
 * Every claim is something the app does today: pages are counted on the
 * phone before payment (lib/analysis), colour is charged per page rather
 * than per document (lib/pricing), payment is UPI online or cash at the
 * counter (pay-sheet), and the job is collected by token (status-island,
 * board). Nothing aspirational belongs here.
 */
const STEPS = [
  {
    icon: Upload,
    title: "Upload from your phone",
    body: "A PDF or photos. The pages are counted on your phone before you pay, so the price is the price.",
  },
  {
    icon: Palette,
    title: "Pay colour only where it's used",
    body: "Each page is checked for colour. Black-and-white pages are charged at the black-and-white rate, even in a colour document.",
  },
  {
    icon: Ticket,
    title: "Pay with UPI, collect by token",
    body: "Pay online or in cash at the counter. You get a token; the desk prints the set and calls it when it's ready.",
  },
] as const;

export function HowItWorks() {
  return (
    <section data-anim="how" aria-labelledby="how-it-works" className="mt-14">
      <p className="label-caps m-0 flex items-center gap-1.5">
        <ScanLine size={12} strokeWidth={2.4} />
        How {BRAND} works
      </p>
      <h2 id="how-it-works" className="font-heading m-0 mt-1 text-[22px] font-bold tracking-[-0.01em] lg:text-[26px]">
        Campus printing without the queue
      </h2>
      <ol className="m-0 mt-5 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="rounded-[20px] border border-line bg-surface p-4 shadow-card">
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-sunk text-ink-soft">
                <step.icon size={15} strokeWidth={2.2} />
              </span>
              <span className="font-mono text-[11px] text-faint">0{i + 1}</span>
            </div>
            <h3 className="m-0 mt-3 text-[14.5px] font-semibold tracking-[-0.01em] text-ink">{step.title}</h3>
            <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
