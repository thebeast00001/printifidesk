"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCard, Loader2 } from "lucide-react";
import { listPayouts, payoutBalance, payoutWindow, periodStart, type FeePeriod, type Payout, type PayoutBalance, type PayoutWindow } from "@/lib/platform";
import { money } from "@/lib/pricing";
import type { Operator } from "@/lib/orders";
import { cn } from "@/lib/utils";

const PERIODS: { id: FeePeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
];

/**
 * What Printify owes this desk from online payments.
 *
 * Students who paid through Cashfree paid Printify; the desk's share of
 * each — bill less fee, refunds off in proportion — is owed to it and
 * arrives as a payout the admin records. Every number is the same
 * function the admin's page reads, so the two never disagree. Drawn only
 * once the desk has taken an online payment or been switched on for them.
 */
export function PayoutPanel({ operator }: { operator: Operator }) {
  const [period, setPeriod] = useState<FeePeriod>("week");
  const [balance, setBalance] = useState<PayoutBalance | null>(null);
  const [window, setWindow] = useState<PayoutWindow | null>(null);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [b, w, p] = await Promise.all([
        payoutBalance(operator.id),
        payoutWindow(operator.id, periodStart(period)),
        listPayouts(operator.id),
      ]);
      setBalance(b);
      setWindow(w);
      setPayouts(p);
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

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-heading m-0 flex items-center gap-2 text-[18px] font-bold">
            <CreditCard size={16} strokeWidth={2.2} />
            Online payments
          </h2>
          <p className="m-0 mt-0.5 text-[12.5px] text-muted">
            Paid through Printify by card or any UPI app. The money lands with Printify; your share is paid out to you.
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
            <Stat label="Owed to you now" value={money(balance.balance, currency)} strong sub={`${money(balance.paid_out, currency)} paid out so far`} />
          </dl>
          <p className="m-0 mt-2.5 font-mono text-[11px] text-muted">
            your share = bill − Printify fee · a refund comes off in proportion · a cancelled order counts for nothing
          </p>

          {payouts.length > 0 && (
            <div className="mt-4 border-t border-line pt-3.5">
              <p className="label-caps m-0 mb-2">Payouts received</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {payouts.slice(0, 8).map((p) => (
                  <li key={p.id} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                    <span className="min-w-0 truncate text-muted">
                      {new Date(p.created_at).toLocaleDateString([], { day: "numeric", month: "short" })}
                      {p.note ? ` · ${p.note}` : ""}
                    </span>
                    <span className="font-mono tabular-nums">{money(p.amount, currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
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
