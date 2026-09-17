"use client";

import { money, paise, perPage, type LineBill, type Quote, type RateCard } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/** "3" for 3.00, "2.5" for 2.50 — the percentage as a person would say it. */
const trimPercent = (p: number) => String(Number(p.toFixed(2)));

/**
 * The bill, the way a receipt reads: each file with the arithmetic that
 * produced its price, then what applied to the whole order, then the total.
 *
 * Every number is from `quoteOrder()` — the same function that priced the
 * job in the database — and the parts of each line sum to that line, and the
 * lines sum to the total, to the paisa. A student can check it against the
 * rate card with a pen.
 */
export function Bill({
  quote,
  card,
  names,
  compact,
  tone = "surface",
}: {
  quote: Quote;
  card: RateCard;
  /** File names, in line order. Falls back to "File 1". */
  names?: (string | undefined)[];
  /** Fewer rows: hides the per-page arithmetic and keeps the line totals. */
  compact?: boolean;
  /** `shell` draws on the dark capsule; `surface` on a card. */
  tone?: "surface" | "shell";
}) {
  const cur = card.currency;
  const muted = tone === "shell" ? "text-shell-faint" : "text-muted";
  const line = tone === "shell" ? "border-shell-line" : "border-line";

  return (
    <div className="text-[12.5px]">
      {quote.lines.map((l, i) => (
        <LineRows
          key={i}
          line={l}
          name={names?.[i]?.trim() || `File ${i + 1}`}
          card={card}
          compact={compact}
          muted={muted}
          divider={line}
        />
      ))}

      <div className={cn("mt-2 border-t pt-2", line)}>
        {/* The cover sheet (0044) is inside the price and disclosed in the
            terms, not itemised here — the owner's call. The "Files" row is
            what the lines come to with it, so the arithmetic on screen adds up. */}
        {quote.lines.length > 1 && <Row label="Files" value={money(quote.subtotal + quote.cover, cur)} muted={muted} />}
        {quote.topUp > 0 && (
          <Row
            label={`Small-order top-up`}
            hint={`the desk's minimum is ${money(card.minOrder, cur)}`}
            value={`+${money(quote.topUp, cur)}`}
            muted={muted}
          />
        )}
        {quote.platformFee > 0 && (
          <Row
            label={`Platform fee${card.platformFeePercent > 0 ? ` (${trimPercent(card.platformFeePercent)}%)` : ""}`}
            hint={
              card.platformFeeMin > 0 && quote.platformFee === paise(card.platformFeeMin)
                ? `the minimum is ${money(card.platformFeeMin, cur)}`
                : "Printifi's share, paid with the order"
            }
            value={`+${money(quote.platformFee, cur)}`}
            muted={muted}
          />
        )}
        {quote.rounding > 0 && (
          <Row
            label="Rounded to the rupee"
            hint="this desk takes whole rupees"
            value={`+${money(quote.rounding, cur)}`}
            muted={muted}
          />
        )}
        <Row
          label="Total"
          value={money(quote.total, cur)}
          strong
          muted={muted}
        />
        {quote.smartSaving > 0 && (
          <p className={cn("m-0 mt-1.5 text-[11.5px] leading-relaxed", muted)}>
            Full colour would have been {money(quote.fullColourTotal, cur)}. Smart colour saved{" "}
            <b className="font-semibold">{money(quote.smartSaving, cur)}</b> by printing only the pages
            that have colour in colour.
          </p>
        )}
      </div>
    </div>
  );
}

function LineRows({
  line,
  name,
  card,
  compact,
  muted,
  divider,
}: {
  line: LineBill;
  name: string;
  card: RateCard;
  compact?: boolean;
  muted: string;
  divider: string;
}) {
  const cur = card.currency;
  const copies = Math.max(1, line.config.copies);
  const x = copies > 1 ? ` × ${copies} copies` : "";

  return (
    <div className={cn("border-b py-2 first:pt-0 last:border-0", divider)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-semibold">{name}</span>
        <span className="shrink-0 font-mono tabular-nums">{money(line.price, cur)}</span>
      </div>

      {!compact && (
        <div className="mt-1 flex flex-col gap-0.5">
          {line.bwPages > 0 && (
            <Row
              label={`${line.bwPages} page${line.bwPages === 1 ? "" : "s"} black & white`}
              hint={`${perPage(card.bwPerPage, cur)}${x}`}
              value={money(line.bwCost, cur)}
              muted={muted}
              sub
            />
          )}
          {line.inkedPages > 0 && (
            <Row
              label={`${line.inkedPages} page${line.inkedPages === 1 ? "" : "s"} colour`}
              hint={`${perPage(card.colourPerPage, cur)}${x}`}
              value={money(line.colourCost, cur)}
              muted={muted}
              sub
            />
          )}
          {line.bulkSaving > 0 && (
            <Row
              label={`Bulk, ${card.bulkThreshold}+ pages`}
              hint={`−${Math.round((1 - card.bulkMultiplier) * 100)}% on paper`}
              value={`−${money(line.bulkSaving, cur)}`}
              muted={muted}
              sub
            />
          )}
          {line.duplexSaving > 0 && (
            <Row
              label="Both sides"
              hint={`−${Math.round(card.duplexDiscount * 100)}%`}
              value={`−${money(line.duplexSaving, cur)}`}
              muted={muted}
              sub
            />
          )}
          {line.binding > 0 && (
            <Row
              label="Staple"
              hint={`${money(card.staplePrice, cur)} each${x}`}
              value={money(line.binding, cur)}
              muted={muted}
              sub
            />
          )}
          {/* The desk's extras this file chose, each by the desk's own name. */}
          {card.extras
            .filter((e) => (line.config.extras ?? []).includes(e.id))
            .map((e) => {
              const copies = Math.max(1, line.config.copies);
              const amount = e.per === "copy" ? e.price * copies : e.price;
              return (
                <Row
                  key={e.id}
                  label={e.name}
                  hint={e.per === "copy" ? `${money(e.price, cur)} each${x}` : "once"}
                  value={money(amount, cur)}
                  muted={muted}
                  sub
                />
              );
            })}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  value,
  strong,
  sub,
  muted,
}: {
  label: string;
  hint?: string;
  value: string;
  strong?: boolean;
  sub?: boolean;
  muted: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", sub && "pl-2")}>
      <span className={cn("min-w-0 truncate", sub && muted, strong && "text-[13.5px] font-semibold")}>
        {label}
        {hint && <span className={cn("ml-1.5 font-mono text-[10.5px]", muted)}>{hint}</span>}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono tabular-nums",
          sub && muted,
          strong && "font-figure text-[17px] font-extrabold",
        )}
      >
        {value}
      </span>
    </div>
  );
}
