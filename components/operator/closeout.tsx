"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, Loader2, Lock, Send } from "lucide-react";
import { closeDesk, recentCloseouts, sendMessage, type Closeout } from "@/lib/desk";
import { operatorOrders, statsForRange, type RangeStats } from "@/lib/operator";
import { money } from "@/lib/pricing";
import type { Operator, OrderRow } from "@/lib/orders";
import { clockLabel, cn, spring } from "@/lib/utils";
import { hoursOn, localParts } from "@/lib/hours";

/**
 * Closing out the day, in the order a person counts it.
 *
 * Expected cash comes from today's collected cash orders; the operator types
 * what's in the drawer; the difference is shown, not hidden. UPI is listed to
 * reconcile against their own app. Anything still on the shelf gets a nudge.
 * Then the desk closes. One row per day — closing twice replaces the count.
 */
export function CloseoutPanel({ operator, onClosed }: { operator: Operator; onClosed: () => void }) {
  const [stats, setStats] = useState<RangeStats | null>(null);
  const [shelf, setShelf] = useState<OrderRow[]>([]);
  const [history, setHistory] = useState<Closeout[]>([]);
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<Closeout | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [s, orders, past] = await Promise.all([
      statsForRange(operator.id, start),
      operatorOrders(operator.id, { sinceDays: 1 }),
      recentCloseouts(operator.id),
    ]);
    setStats(s);
    setShelf(orders.filter((o) => o.status === "ready"));
    setHistory(past);
  }, [operator.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const currency = operator.currency ?? "₹";
  const expected = Math.round(Number(stats?.cash_total ?? 0));
  const countedValue = counted === "" ? null : Number(counted);
  const diff = countedValue === null || !Number.isFinite(countedValue) ? null : countedValue - expected;

  async function close() {
    setClosing(true);
    setError(null);
    try {
      const row = await closeDesk(operator.id, countedValue, note);
      setClosed(row);
      onClosed();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't close the desk.");
    } finally {
      setClosing(false);
    }
  }

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <h2 className="font-heading m-0 text-[18px] font-bold">Close out</h2>
      <p className="m-0 mt-1 mb-4 text-[12.5px] text-muted">
        Count the drawer, check UPI against your app, chase what&apos;s on the shelf, close.
      </p>

      {!stats ? (
        <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={15} className="animate-spin" />
          Adding up today…
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {/* ---- cash ---- */}
          <div className="rounded-[16px] border border-line bg-surface-sunk p-4">
            <p className="label-caps m-0">Cash</p>
            <p className="m-0 mt-1 text-[12.5px] text-muted">
              Expected from today&apos;s cash orders
            </p>
            <p className="font-figure m-0 text-[28px] font-extrabold">{money(expected, currency)}</p>

            <label className="mt-3 flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold">In the drawer</span>
              <input
                value={counted}
                onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ""))}
                inputMode="decimal"
                placeholder={String(expected)}
                className="rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[15px] outline-none focus:border-ink"
              />
            </label>

            {diff !== null && (
              <p
                className={cn(
                  "m-0 mt-2 text-[12.5px] font-semibold",
                  diff === 0 ? "text-sage-ink" : "text-clay-ink dark:text-clay",
                )}
              >
                {diff === 0
                  ? "Matches."
                  : diff > 0
                    ? `${money(Math.round(diff), currency)} over.`
                    : `${money(Math.round(-diff), currency)} short.`}
              </p>
            )}
          </div>

          {/* ---- upi ---- */}
          <div className="rounded-[16px] border border-line bg-surface-sunk p-4">
            <p className="label-caps m-0">UPI</p>
            <p className="m-0 mt-1 text-[12.5px] text-muted">Should match your UPI app for today</p>
            <p className="font-figure m-0 text-[28px] font-extrabold">
              {money(Math.round(Number(stats.upi_total)), currency)}
            </p>
            <dl className="m-0 mt-3 grid grid-cols-2 gap-y-1 text-[12px]">
              <dt className="text-muted">Orders</dt>
              <dd className="m-0 text-right font-mono">{stats.orders}</dd>
              <dt className="text-muted">Collected</dt>
              <dd className="m-0 text-right font-mono">{stats.collected}</dd>
              <dt className="text-muted">Refunded</dt>
              <dd className="m-0 text-right font-mono">
                {money(Math.round(Number(stats.refunded)), currency)}
              </dd>
            </dl>
          </div>

          {/* ---- shelf ---- */}
          <div className="rounded-[16px] border border-line bg-surface-sunk p-4 sm:col-span-2">
            <p className="label-caps m-0">Still on the shelf</p>
            {shelf.length === 0 ? (
              <p className="m-0 mt-1 text-[12.5px] text-muted">Nothing. Everything printed today went home.</p>
            ) : (
              <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
                {shelf.map((o) => (
                  <ShelfRow key={o.id} order={o} closesAt={hoursOn(operator, localParts(new Date(), operator.tz).day)?.close ?? operator.closes_at} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <label className="mt-4 flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold">
          Note <span className="font-normal text-faint">optional</span>
        </span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="Toner changed, drawer float ₹500, whatever tomorrow should know"
          className="rounded-lg border border-line bg-surface-sunk px-3 py-2 text-[12.5px] outline-none focus:border-ink"
        />
      </label>

      <motion.button
        whileTap={{ scale: 0.98 }}
        transition={spring}
        disabled={closing || !stats}
        onClick={close}
        className="mt-4 flex h-[50px] w-full items-center justify-center gap-2 rounded-2xl bg-ink text-[14.5px] font-semibold text-paper disabled:opacity-60"
      >
        {closing ? <Loader2 size={16} className="animate-spin" /> : closed ? <Check size={16} strokeWidth={2.6} /> : <Lock size={16} strokeWidth={2.2} />}
        {closing ? "Closing…" : closed ? "Closed — count saved" : "Close the desk"}
      </motion.button>
      <p className="m-0 mt-2 text-center text-[11px] text-muted">
        Sets Printify to closed and saves today&apos;s count. Closing again today replaces it.
      </p>
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}

      {history.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="label-caps m-0 mb-2">Past closes</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {history.map((c) => {
              const d = c.counted_cash === null ? null : Number(c.counted_cash) - Number(c.expected_cash);
              return (
                <li key={c.id} className="flex items-baseline justify-between gap-3 text-[12px]">
                  <span className="font-mono text-muted">
                    {new Date(c.day).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}
                  </span>
                  <span className="font-mono">
                    cash {money(Math.round(Number(c.expected_cash)), currency)}
                    {d !== null && d !== 0 && (
                      <span className="text-clay-ink dark:text-clay">
                        {" "}
                        ({d > 0 ? "+" : "−"}{money(Math.round(Math.abs(d)), currency)})
                      </span>
                    )}
                    {" · upi "}
                    {money(Math.round(Number(c.upi_total)), currency)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/** One uncollected job, with a nudge that goes out as a message and a push. */
function ShelfRow({ order, closesAt }: { order: OrderRow; closesAt: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  async function nudge() {
    setState("sending");
    try {
      const closes = clockLabel(closesAt) ?? closesAt.slice(0, 5);
      await sendMessage(
        order.id,
        `Your print is ready and waiting. We close at ${closes} today — it'll still be here tomorrow if you can't make it.`,
      );
      setState("sent");
    } catch {
      setState("failed");
    }
  }

  return (
    <li className="flex items-center gap-3 text-[12.5px]">
      <span className="rounded-lg bg-surface px-2 py-1 font-mono text-[11px] font-medium">{order.token}</span>
      <span className="min-w-0 flex-1 truncate">{order.order_items?.[0]?.name ?? `${order.pages} pages`}</span>
      <button
        onClick={nudge}
        disabled={state === "sending" || state === "sent"}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors",
          state === "sent"
            ? "border-sage bg-sage text-sage-ink"
            : "border-line bg-surface text-ink-soft hover:border-ink",
        )}
      >
        {state === "sending" ? (
          <Loader2 size={12} className="animate-spin" />
        ) : state === "sent" ? (
          <Check size={12} strokeWidth={2.6} />
        ) : (
          <Send size={12} strokeWidth={2.2} />
        )}
        {state === "sent" ? "Nudged" : state === "failed" ? "Retry" : "Nudge"}
      </button>
    </li>
  );
}
