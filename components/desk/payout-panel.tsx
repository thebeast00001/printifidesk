"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ChevronDown, CreditCard, Download, Loader2 } from "lucide-react";
import {
  listPayouts,
  nextPayoutDate,
  payoutBalance,
  payoutOrders,
  payoutWindow,
  periodStart,
  platformSettings,
  WEEKDAYS,
  type FeePeriod,
  type Payout,
  type PayoutBalance,
  type PayoutOrderRow,
  type PayoutWindow,
} from "@/lib/platform";
import { money } from "@/lib/pricing";
import type { Operator } from "@/lib/orders";
import { cn } from "@/lib/utils";

const PERIODS: { id: FeePeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
];

/**
 * What Printify owes this desk from online payments — and (0040) the
 * proof: every online-paid order with its bill, the fee, the share and
 * Cashfree's reference; the day the balance is paid; and, for every payout
 * received, the exact orders it covered, downloadable as a CSV. Every
 * number is the same function the admin's page reads, so the two never
 * disagree. Drawn only once the desk has taken an online payment or been
 * switched on for them.
 */
export function PayoutPanel({ operator }: { operator: Operator }) {
  const [period, setPeriod] = useState<FeePeriod>("week");
  const [balance, setBalance] = useState<PayoutBalance | null>(null);
  const [window, setWindow] = useState<PayoutWindow | null>(null);
  const [orders, setOrders] = useState<PayoutOrderRow[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [payoutDay, setPayoutDay] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const from = periodStart(period);
      const [b, w, o, p, s] = await Promise.all([
        payoutBalance(operator.id),
        payoutWindow(operator.id, from),
        payoutOrders(operator.id, from),
        listPayouts(operator.id),
        platformSettings(),
      ]);
      setBalance(b);
      setWindow(w);
      setOrders(o);
      setPayouts(p);
      setPayoutDay(s.payout_weekday);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      // Before 0035: nothing here, nothing to say.
      if (!/could not find|does not exist|schema cache/i.test(m)) setError(m || "Couldn't read payouts.");
      setBalance({ owed: 0, paid_out: 0, balance: 0, orders: 0 });
      setWindow({ orders: 0, gross: 0, fee: 0, share: 0 });
    }
  }, [operator.id, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const on = operator.gateway_status === "collect";
  if (balance !== null && !on && balance.owed === 0 && balance.paid_out === 0) return null;
  const currency = operator.currency ?? "₹";
  const next = payoutDay ? nextPayoutDate(payoutDay, operator.tz) : null;
  const dayName = payoutDay ? WEEKDAYS[payoutDay - 1] : null;

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-heading m-0 flex items-center gap-2 text-[18px] font-bold">
            <CreditCard size={16} strokeWidth={2.2} />
            Online payments
          </h2>
          <p className="m-0 mt-0.5 text-[12.5px] text-muted">
            Paid through Printify by card or any UPI app. The money lands with Printify; your share is paid out to you
            {dayName ? ` every ${dayName}` : ""}.
          </p>
        </div>
        <div className="flex gap-0.5 rounded-full border border-line bg-surface-sunk p-1">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={cn(
                "rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors",
                period === p.id ? "bg-ink text-paper" : "text-muted hover:text-ink-soft",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {operator.gateway_paused && (
        <p className="m-0 mt-3 rounded-[12px] bg-clay px-3.5 py-2.5 text-[12.5px] text-clay-ink">
          Paused by you — students are paying your UPI id directly. What&apos;s already owed below is still paid out on the payout day.
        </p>
      )}

      {error && <p className="m-0 mt-3 text-[12.5px] text-clay-ink dark:text-clay">{error}</p>}
      {balance === null || window === null ? (
        <p className="m-0 mt-3 flex items-center gap-2 text-[12.5px] text-muted">
          <Loader2 size={14} className="animate-spin" />
          Reading…
        </p>
      ) : (
        <>
          <dl className="m-0 mt-3.5 grid gap-2 sm:grid-cols-3">
            <Stat label={`Online ${PERIODS.find((p) => p.id === period)?.label.toLowerCase()}`} value={String(window.orders)} sub="orders" />
            <Stat label="Your share of those" value={money(window.share, currency)} sub={`of ${money(window.gross, currency)}, after the ${money(window.fee, currency)} fee`} />
            <Stat
              label="Owed to you now"
              value={money(balance.balance, currency)}
              strong
              sub={
                next && balance.balance > 0
                  ? `next payout ${next.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}`
                  : `${money(balance.paid_out, currency)} paid out so far`
              }
            />
          </dl>
          <p className="m-0 mt-2.5 font-mono text-[11px] text-muted">
            your share = bill − Printify fee · a refund comes off in proportion · a cancelled order counts for nothing
          </p>
          {next && (
            <p className="m-0 mt-2 flex items-center gap-1.5 text-[12px] text-ink-soft">
              <CalendarClock size={13} strokeWidth={2.2} />
              Printify pays what&apos;s owed every {dayName}. Each payout appears below with the orders it covered.
            </p>
          )}

          {/* The money, per order: the line a desk can check against its own count. */}
          {orders.length > 0 && (
            <div className="mt-4 border-t border-line pt-3.5">
              <p className="label-caps m-0 mb-2">Online orders {PERIODS.find((p) => p.id === period)?.label.toLowerCase()}</p>
              <OrderLines rows={orders} currency={currency} />
            </div>
          )}

          {payouts.length > 0 && (
            <div className="mt-4 border-t border-line pt-3.5">
              <p className="label-caps m-0 mb-2">Payouts received</p>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {payouts.slice(0, 12).map((p) => (
                  <PayoutRow key={p.id} payout={p} operator={operator} currency={currency} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function OrderLines({ rows, currency }: { rows: PayoutOrderRow[]; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-[12px]">
        <thead>
          <tr className="text-left text-[10.5px] tracking-[0.06em] text-muted uppercase">
            <th className="py-1 pr-2 font-semibold">Paid</th>
            <th className="py-1 pr-2 font-semibold">Token</th>
            <th className="py-1 pr-2 text-right font-semibold">Bill</th>
            <th className="py-1 pr-2 text-right font-semibold">Fee</th>
            <th className="py-1 pr-2 text-right font-semibold">Refund</th>
            <th className="py-1 pr-2 text-right font-semibold">Yours</th>
            <th className="py-1 font-semibold">Cashfree ref</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line">
              <td className="py-1.5 pr-2 whitespace-nowrap text-muted">
                {new Date(r.paid_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
              </td>
              <td className="py-1.5 pr-2 font-mono">{r.token ?? "—"}</td>
              <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{money(r.total, currency)}</td>
              <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-muted">−{money(r.platform_fee, currency)}</td>
              <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-muted">{r.refund_amount ? `−${money(r.refund_amount, currency)}` : ""}</td>
              <td className="py-1.5 pr-2 text-right font-mono font-semibold tabular-nums">{money(r.share, currency)}</td>
              <td className="py-1.5 font-mono text-[11px] text-muted">{r.payment_id ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One payout, and on tap the orders it covered — with a CSV of them for the accountant. */
function PayoutRow({ payout, operator, currency }: { payout: Payout; operator: Operator; currency: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PayoutOrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const covered = payout.covers_from && payout.covers_to;

  useEffect(() => {
    if (!open || rows !== null || !covered) return;
    payoutOrders(operator.id, payout.covers_from!, payout.covers_to!)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't read the statement."));
  }, [open, rows, covered, operator.id, payout.covers_from, payout.covers_to]);

  const total = rows?.reduce((n, r) => n + r.share, 0) ?? null;

  function download() {
    if (!rows) return;
    const esc = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["paid_at", "token", "order_id", "bill", "platform_fee", "refund", "your_share", "cashfree_payment_id", "status"].join(","),
      ...rows.map((r) =>
        [r.paid_at, r.token, r.id, r.total.toFixed(2), r.platform_fee.toFixed(2), (r.refund_amount ?? 0).toFixed(2), r.share.toFixed(2), r.payment_id, r.status].map(esc).join(","),
      ),
      ["", "", "total", "", "", "", (total ?? 0).toFixed(2), "", ""].map(esc).join(","),
      ["", "", "paid out", "", "", "", payout.amount.toFixed(2), payout.note ?? "", new Date(payout.created_at).toISOString()].map(esc).join(","),
    ];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `printify-payout-${new Date(payout.created_at).toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <li className="rounded-xl border border-line bg-surface-sunk">
      <button
        onClick={() => covered && setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-[12.5px]"
      >
        <span className="min-w-0 truncate text-muted">
          {new Date(payout.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
          {payout.note ? ` · ${payout.note}` : ""}
          {covered
            ? ` · orders paid up to ${new Date(payout.covers_to!).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
            : ""}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="font-mono font-semibold tabular-nums">{money(payout.amount, currency)}</span>
          {covered && <ChevronDown size={14} strokeWidth={2.2} className={cn("text-muted transition-transform", open && "rotate-180")} />}
        </span>
      </button>
      {open && covered && (
        <div className="border-t border-line px-3 py-2.5">
          {rows === null && !error && (
            <p className="m-0 flex items-center gap-2 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" />
              Reading the statement…
            </p>
          )}
          {error && <p className="m-0 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
          {rows && rows.length === 0 && <p className="m-0 text-[12px] text-muted">No online orders in this payout&apos;s window.</p>}
          {rows && rows.length > 0 && (
            <>
              <OrderLines rows={rows} currency={currency} />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <span className="text-muted">
                  {rows.length} {rows.length === 1 ? "order" : "orders"} · shares add up to{" "}
                  <b className="font-mono font-semibold text-ink">{money(total ?? 0, currency)}</b>
                  {Math.abs((total ?? 0) - payout.amount) > 0.005 && (
                    <> · paid out {money(payout.amount, currency)}{(total ?? 0) > payout.amount ? " — the rest carries to the next payout" : ""}</>
                  )}
                </span>
                <button onClick={download} className="flex items-center gap-1.5 font-semibold text-ink-soft underline-offset-2 hover:underline">
                  <Download size={13} strokeWidth={2.2} />
                  Download CSV
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Stat({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-[14px] border border-line p-3", strong ? "bg-ink text-paper" : "bg-surface-sunk")}>
      <dt className={cn("text-[11.5px]", strong ? "text-paper/70" : "text-muted")}>{label}</dt>
      <dd className="font-figure m-0 mt-0.5 text-[20px] font-extrabold tabular-nums">{value}</dd>
      {sub && <dd className={cn("m-0 mt-0.5 text-[11px]", strong ? "text-paper/70" : "text-muted")}>{sub}</dd>}
    </div>
  );
}
