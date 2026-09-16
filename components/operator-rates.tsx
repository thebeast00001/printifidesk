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
 *
 * Always four tiles. A rate that is zero reads as "free" or "same price"
 * rather than vanishing, so the row never breaks unevenly — the earlier
 * version listed whatever was non-zero in a three-column grid, and five
 * entries left one on a line by itself.
 */
export function OperatorRates() {
  const { operator, wait, ready } = useOperatorWait();

  // Nothing to say until it's loaded, and nothing honest to say if no operator
  // is set up — the diagnostics page covers that case properly.
  if (!ready || !operator) return null;

  const card = rateCardOf(operator);
  const open = wait?.open ?? operator.is_open;

  const tiles: { label: string; value: string; muted?: boolean }[] = [
    { label: "Black & white", value: perPage(card.bwPerPage, card.currency) },
    { label: "Colour", value: perPage(card.colourPerPage, card.currency) },
    card.duplexDiscount > 0
      ? { label: "Both sides", value: `−${Math.round(card.duplexDiscount * 100)}%` }
      : { label: "Both sides", value: "same price", muted: true },
    card.staplePrice > 0
      ? { label: "Staple", value: `+${money(card.staplePrice, card.currency)}` }
      : { label: "Staple", value: "free", muted: true },
  ];

  const footer = [
    operator.campus,
    card.minOrder > 0 ? `${money(card.minOrder, card.currency)} minimum` : null,
    "smart colour charges only the pages that need it",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mt-3.5 rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h3 className="m-0 text-[14.5px] font-semibold tracking-[-0.01em]">
          {operator.short_name?.trim() || operator.name}
        </h3>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[10.5px] font-semibold",
            open ? "bg-sage text-sage-ink" : "border border-line bg-surface-sunk text-muted",
          )}
        >
          {open ? "Printifi open" : "Printifi closed"}
        </span>
        {open && wait && wait.wait_minutes > 0 && (
          <span className="font-mono text-[11px] text-muted">about {wait.wait_minutes} min wait</span>
        )}
        {!open && operator.status_note?.trim() && (
          <span className="text-[11.5px] text-muted">{operator.status_note.trim()}</span>
        )}
      </div>

      {/* Value on top, label beneath — read left to right like a price list,
          not looked up like a table. */}
      <div className="mt-3.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-[14px] bg-surface-sunk px-3 py-2.5">
            <p
              className={cn(
                "font-figure m-0 text-[19px] leading-none font-extrabold tabular-nums",
                tile.muted && "text-[15px] font-semibold text-muted",
              )}
            >
              {tile.value}
            </p>
            <p className="m-0 mt-1 text-[11px] text-muted">{tile.label}</p>
          </div>
        ))}
      </div>

      <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">{footer}</p>
    </div>
  );
}
