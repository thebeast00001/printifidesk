"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Download, Loader2 } from "lucide-react";
import { operatorOrders, statsForRange, type RangeStats } from "@/lib/operator";
import { money } from "@/lib/pricing";
import type { Operator } from "@/lib/orders";
import { cn, spring } from "@/lib/utils";

type Window = "today" | "week" | "month";

const WINDOWS: { id: Window; label: string; days: number }[] = [
  { id: "today", label: "Today", days: 0 },
  { id: "week", label: "7 days", days: 7 },
  { id: "month", label: "30 days", days: 30 },
];

function startOf(window: Window): Date {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const days = WINDOWS.find((w) => w.id === window)?.days ?? 0;
  if (days) from.setDate(from.getDate() - days);
  return from;
}

/**
 * What every small shop does at closing time: count the day, split cash from
 * transfers, and see what's still on the shelf uncollected.
 */
export function OperatorDay({ operator }: { operator: Operator }) {
  const [window, setWindow] = useState<Window>("today");
  const [stats, setStats] = useState<RangeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const from = useMemo(() => startOf(window), [window]);

  const load = useCallback(async () => {
    setLoading(true);
    setStats(await statsForRange(operator.id, from));
    setLoading(false);
  }, [operator.id, from]);

  useEffect(() => {
    void load();
  }, [load]);

  const currency = operator.currency ?? "₹";

  const rows: { label: string; value: string; strong?: boolean }[] = stats
    ? [
        { label: "Orders", value: String(stats.orders) },
        { label: "Collected", value: String(stats.collected) },
        { label: "Declined or failed", value: String(stats.declined) },
        { label: "Pages printed", value: String(stats.pages) },
        { label: "Of which colour", value: String(stats.colour_pages) },
        { label: "Cash", value: money(Math.round(Number(stats.cash_total)), currency) },
        { label: "UPI", value: money(Math.round(Number(stats.upi_total)), currency) },
        ...(Number(stats.online_total ?? 0) > 0
          ? [{ label: "Online", value: money(Math.round(Number(stats.online_total)), currency) }]
          : []),
        { label: "Refunded", value: money(Math.round(Number(stats.refunded)), currency) },
        // The fee was inside every total the student paid; it's Printify's,
        // so what the desk actually keeps is shown next to it.
        { label: "Printify fee (to settle)", value: money(Number(stats.platform_fee), currency) },
        {
          label: "Total taken",
          value: money(
            Math.round(Number(stats.revenue) - Number(stats.refunded)),
            currency,
          ),
          strong: true,
        },
        {
          label: "Yours after the fee",
          value: money(
            Math.round(Number(stats.revenue) - Number(stats.refunded) - Number(stats.platform_fee)),
            currency,
          ),
        },
        { label: "Still uncollected", value: String(stats.uncollected) },
        { label: "Median turnaround", value: `${stats.median_minutes} min` },
      ]
    : [];

  /** A real CSV of the orders themselves — the summary above isn't auditable. */
  async function exportCsv() {
    setExporting(true);
    try {
      // The window's own reach, not the portal's fortnight — a thirty-day
      // export that quietly held fourteen would be a wrong number in a ledger.
      const days = WINDOWS.find((w) => w.id === window)?.days ?? 0;
      const all = await operatorOrders(operator.id, { limit: 5000, sinceDays: Math.max(days, 1) });
      const since = from.getTime();
      const scoped = all.filter((o) => new Date(o.created_at).getTime() >= since);

      const header = [
        "token", "placed_at", "status", "pages", "colour_pages", "copies",
        "sides", "binding", "total", "payment_method", "payment_reference",
        "refund_amount", "collected_at",
      ];

      // Quote everything and double embedded quotes — a filename with a comma
      // silently shifts every later column otherwise.
      const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

      const lines = [
        header.join(","),
        ...scoped.map((o) =>
          [
            o.token, o.created_at, o.status, o.pages, o.colour_pages,
            o.config?.copies ?? 1, o.config?.sides ?? "", o.config?.binding ?? "",
            o.total, o.payment_method ?? "", o.payment_reference ?? "",
            o.refund_amount ?? "", o.collected_at ?? "",
          ]
            .map(cell)
            .join(","),
        ),
      ];

      // BOM so Excel opens ₹ and non-ASCII filenames correctly.
      const blob = new Blob(["﻿" + lines.join("\r\n")], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `printify-${window}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading m-0 text-[18px] font-bold">Takings</h2>

        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 rounded-full border border-line bg-surface-sunk p-1">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => setWindow(w.id)}
                className={cn(
                  "relative rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors",
                  window === w.id ? "text-paper" : "text-muted hover:text-ink-soft",
                )}
              >
                {window === w.id && (
                  <motion.span
                    layoutId="day-window"
                    transition={spring}
                    className="absolute inset-0 rounded-full bg-ink"
                  />
                )}
                <span className="relative">{w.label}</span>
              </button>
            ))}
          </div>

          <button
            onClick={exportCsv}
            disabled={exporting}
            className="flex h-9 items-center gap-1.5 rounded-xl border border-line px-3 text-[12px] font-semibold text-ink-soft disabled:opacity-50"
          >
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} strokeWidth={2.2} />}
            CSV
          </button>
        </div>
      </div>

      {loading ? (
        <p className="m-0 flex items-center gap-2.5 py-4 text-[13px] text-muted">
          <Loader2 size={15} className="animate-spin" />
          Counting…
        </p>
      ) : !stats ? (
        <p className="m-0 py-4 text-[13px] text-muted">No figures for this period.</p>
      ) : (
        <dl className="m-0 grid gap-x-8 gap-y-2 sm:grid-cols-2">
          {rows.map((row) => (
            <div
              key={row.label}
              className={cn(
                "flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0",
                row.strong && "border-b-0 sm:col-span-2",
              )}
            >
              <dt className={cn("text-[12.5px]", row.strong ? "font-semibold" : "text-muted")}>
                {row.label}
              </dt>
              <dd
                className={cn(
                  "m-0 font-mono tabular-nums",
                  row.strong ? "font-figure text-[20px] font-extrabold" : "text-[12.5px]",
                )}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
