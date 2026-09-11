"use client";

import { useOperatorWait } from "@/hooks/use-tracking";
import { money, perPage, rateCardOf } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * What printing here actually costs, shown before anything is uploaded.
 *
 * An empty shelf is the honest thing to show a new account — there is nothing
 * to invent — but it answers none of the questions a first-time visitor has.
 * These are the operator's own rates read from their row, so it is real data
 * rather than filler: what a page costs, whether the desk is open, and roughly
 * how long the queue is.
 */
export function OperatorRates() {
  const { operator, wait, ready } = useOperatorWait();

  // Nothing to say until it's loaded, and nothing honest to say if no operator
  // is set up — the diagnostics page covers that case properly.
  if (!ready || !operator) return null;

  const card = rateCardOf(operator);
  const open = wait?.open ?? operator.is_open;

  const rows: { label: string; value: string }[] = [
    { label: "Black & white", value: perPage(card.bwPerPage, card.currency) },
    { label: "Colour", value: perPage(card.colourPerPage, card.currency) },
    ...(card.duplexDiscount > 0
      ? [{ label: "Both sides", value: `−${Math.round(card.duplexDiscount * 100)}%` }]
      : []),
    ...(card.staplePrice > 0
      ? [{ label: "Staple", value: `+${money(card.staplePrice, card.currency)}` }]
      : []),
    ...(card.minOrder > 0
      ? [{ label: "Minimum", value: money(card.minOrder, card.currency) }]
      : []),
  ];

  return (
    <div className="mt-3.5 rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h3 className="m-0 text-[14px] font-semibold tracking-[-0.01em]">
          {operator.short_name?.trim() || operator.name}
        </h3>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[10.5px] font-semibold",
            open ? "bg-sage text-sage-ink" : "border border-line bg-surface-sunk text-muted",
          )}
        >
          {open ? "Printify open" : "Printify closed"}
        </span>
        {open && wait && wait.wait_minutes > 0 && (
          <span className="font-mono text-[11px] text-muted">
            about {wait.wait_minutes} min wait
          </span>
        )}
      </div>

      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-[12px] text-muted">{row.label}</dt>
            <dd className="m-0 font-mono text-[12px] tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">
        {operator.campus}
        {operator.status_note?.trim() ? ` · ${operator.status_note.trim()}` : ""}
        {" · "}
        Smart colour prices each page on its own, so a mostly-black document
        doesn&apos;t pay colour rates.
      </p>
    </div>
  );
}
