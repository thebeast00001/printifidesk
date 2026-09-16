"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import QRCode from "qrcode";
import { Loader2, Receipt } from "lucide-react";
import {
  feeBalance,
  feeStatus,
  feeWindow,
  listSettlements,
  periodStart,
  platformSettings,
  type FeeBalance,
  type FeePeriod,
  type FeeStatus,
  type FeeWindow,
  type PlatformSettings,
  type Settlement,
} from "@/lib/platform";
import { money } from "@/lib/pricing";
import { isValidVpa, upiLink } from "@/lib/upi";
import type { Operator } from "@/lib/orders";
import { cn, spring } from "@/lib/utils";

const PERIODS: { id: FeePeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
];

/**
 * What the desk owes Printifi.
 *
 * Every collected order carried a platform fee — a line the student saw and
 * paid with the order, into the desk's own UPI or cash drawer. This is where
 * that adds up: by period, all time, minus what's been settled. The numbers
 * are the database's, to the paisa; nothing here is estimated. The QR pays
 * the outstanding balance to Printifi's VPA, and the admin records it on
 * the other side.
 */
export function FeePanel({ operator }: { operator: Operator }) {
  const [period, setPeriod] = useState<FeePeriod>("today");
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [window, setWindow] = useState<FeeWindow | null>(null);
  const [balance, setBalance] = useState<FeeBalance | null>(null);
  const [status, setStatus] = useState<FeeStatus | null>(null);
  const [paid, setPaid] = useState<Settlement[]>([]);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const from = useMemo(() => periodStart(period), [period]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ps, w, b, s, st] = await Promise.all([
        platformSettings(),
        feeWindow(operator.id, from),
        feeBalance(operator.id),
        listSettlements(operator.id),
        // A project between 0022 and 0025 still gets the rest of the panel.
        feeStatus(operator.id).catch(() => null),
      ]);
      setSettings(ps);
      setWindow(w);
      setBalance(b);
      setPaid(s);
      setStatus(st);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the fee ledger.");
    }
  }, [operator.id, from]);

  useEffect(() => {
    void load();
  }, [load]);

  const currency = operator.currency ?? "₹";
  const outstanding = balance?.outstanding ?? 0;
  const payable = settings?.payee_vpa && isValidVpa(settings.payee_vpa) && outstanding > 0;
  // Printifi's own id follows the same rule as a desk's: a personal id
  // can't take the amount in the link, so the desk types it.
  const payeeMerchant = settings?.payee_kind === "merchant";
  const link = payable
    ? upiLink({
        vpa: settings!.payee_vpa!,
        payeeName: settings!.payee_name || "Printifi",
        amount: payeeMerchant ? outstanding : undefined,
        note: `Printifi fee · ${operator.short_name || operator.name}`.slice(0, 50),
        reference: `PRINTIFYFEE${operator.id.replace(/-/g, "").slice(0, 8)}`,
      })
    : null;

  useEffect(() => {
    if (!link) return setQr(null);
    let alive = true;
    void QRCode.toDataURL(link, { margin: 1, width: 360, errorCorrectionLevel: "M" })
      .then((url) => alive && setQr(url))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [link]);

  const pct = settings ? String(Number(settings.fee_percent.toFixed(2))) : null;

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading m-0 flex items-center gap-2 text-[18px] font-bold">
            <Receipt size={16} strokeWidth={2.2} />
            Printifi fee
          </h2>
          <p className="m-0 mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-muted">
            {pct === null
              ? "Loading…"
              : Number(pct) === 0
                ? "No platform fee is set right now."
                : `${pct}% of every collected order, shown on the student's bill and paid to you with it. It's Printifi's; settle it from here.`}
          </p>
        </div>
        <div className="flex gap-0.5 rounded-full border border-line bg-surface-sunk p-1">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={cn(
                "relative rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors",
                period === p.id ? "text-paper" : "text-muted hover:text-ink-soft",
              )}
            >
              {period === p.id && (
                <motion.span layoutId="fee-period" transition={spring} className="absolute inset-0 rounded-full bg-ink" />
              )}
              <span className="relative">{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="m-0 text-[12.5px] text-clay-ink dark:text-clay">{error}</p>
      ) : !window || !balance ? (
        <p className="m-0 flex items-center gap-2 py-3 text-[13px] text-muted">
          <Loader2 size={15} className="animate-spin" />
          Counting…
        </p>
      ) : (
        <>
          <dl className="m-0 grid gap-2 sm:grid-cols-3">
            <Stat label={`Collected ${PERIODS.find((p) => p.id === period)?.label.toLowerCase()}`} value={String(window.orders)} sub="orders" />
            <Stat
              label="Fee on those"
              value={money(window.fee, currency)}
              sub={(window.retained ?? 0) > 0 ? `+ ${money(window.retained ?? 0, currency)} already taken on online payments` : undefined}
            />
            <Stat label="Outstanding, all time" value={money(outstanding, currency)} strong />
          </dl>

          <p className="m-0 mt-2.5 font-mono text-[11px] text-muted">
            accrued {money(balance.accrued, currency)} · settled {money(balance.settled, currency)} · fees count on
            collected orders that weren&apos;t fully refunded
          </p>

          {status && status.due > 0 && (
            // What's due from earlier months, and the day it starts to matter.
            <p
              className={cn(
                "m-0 mt-2.5 rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed",
                status.overdue ? "bg-clay text-clay-ink" : "bg-bone text-ink",
              )}
            >
              {status.overdue ? (
                <>
                  <b className="font-semibold">Overdue:</b> {money(status.due, currency)} for{" "}
                  {monthName(status.due_month)} and earlier. The desk can&apos;t be opened until this is
                  settled — pay it below and Printifi records it.
                </>
              ) : (
                <>
                  <b className="font-semibold">Due:</b> {money(status.due, currency)} for{" "}
                  {monthName(status.due_month)} and earlier. Settle by{" "}
                  {new Date(status.locks_on).toLocaleDateString([], { day: "numeric", month: "long" })} — after
                  that the desk can&apos;t open until it&apos;s paid.
                </>
              )}
            </p>
          )}

          {settings && Number(settings.fee_percent) > 0 && (
            <div className="mt-3.5 rounded-[16px] border border-line bg-surface-sunk p-4">
              {!settings.payee_vpa ? (
                <p className="m-0 text-[12.5px] text-muted">
                  Printifi hasn&apos;t set where to send settlements yet. Nothing to pay from here until it does.
                </p>
              ) : outstanding <= 0 ? (
                <p className="m-0 text-[12.5px] font-semibold text-sage-ink">Settled up. Nothing outstanding.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-4">
                  {qr && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={qr} alt="" width={120} height={120} className="size-[120px] shrink-0 rounded-lg bg-white" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="label-caps m-0">Settle with Printifi</p>
                    <p className="font-figure m-0 mt-0.5 text-[24px] font-extrabold tabular-nums">
                      {money(outstanding, currency)}
                    </p>
                    <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">
                      to <span className="font-mono text-ink-soft">{settings.payee_vpa}</span>
                      {settings.payee_name ? ` (${settings.payee_name})` : ""}.{" "}
                      {payeeMerchant
                        ? "Scan from any UPI app, or tap on a phone."
                        : `Scan from any UPI app and type ${money(outstanding, currency)} — a personal id can't carry the amount.`}{" "}
                      Once Printifi records it, it shows below.
                    </p>
                    {link && (
                      <a
                        href={link}
                        className="mt-2.5 inline-flex h-10 items-center rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper"
                      >
                        {payeeMerchant ? `Pay ${money(outstanding, currency)} by UPI` : "Open UPI app"}
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {paid.length > 0 && (
            <div className="mt-3.5">
              <p className="label-caps m-0 mb-1.5">Payments recorded</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {paid.map((s) => (
                  <li key={s.id} className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 text-[12.5px] last:border-0">
                    <span className="min-w-0 truncate text-muted">
                      {new Date(s.created_at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}
                      {s.note ? ` · ${s.note}` : ""}
                    </span>
                    <span className="font-mono tabular-nums">{money(Number(s.amount), currency)}</span>
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

function monthName(firstDay: string): string {
  return new Date(firstDay).toLocaleDateString([], { month: "long", year: "numeric" });
}

function Stat({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-[14px] border border-line p-3", strong ? "bg-ink text-paper" : "bg-surface-sunk")}>
      <dt className={cn("text-[11.5px]", strong ? "text-paper/70" : "text-muted")}>{label}</dt>
      <dd className="font-figure m-0 mt-0.5 text-[20px] font-extrabold tabular-nums">
        {value}
        {sub && <span className={cn("ml-1 text-[12px] font-normal", strong ? "text-paper/70" : "text-muted")}>{sub}</span>}
      </dd>
    </div>
  );
}
