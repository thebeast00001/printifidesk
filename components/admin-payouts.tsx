"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Send, X } from "lucide-react";
import { adminPayoutDesks, nextPayoutDate, periodStart, platformSettings, recordPayout, setPayoutDay, WEEKDAYS, type DeskPayoutRow, type FeePeriod } from "@/lib/platform";
import { money } from "@/lib/pricing";
import { cn } from "@/lib/utils";

const PERIODS: { id: FeePeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
];

/**
 * What Printifi owes each desk from online payments it collected.
 *
 * The mirror of the fee ledger. Every order paid through Cashfree without a
 * split lands in Printifi's account; the desk's share — bill less fee,
 * refunds taken off in proportion, cancelled orders counting for nothing
 * — is owed to it. The admin sends it (UPI, bank, whatever the desk gave)
 * and records it here; the desk sees the same numbers on its Takings.
 * Only ever shown when some desk has been collected for.
 */
export function AdminPayouts() {
  const [period, setPeriod] = useState<FeePeriod>("week");
  const [rows, setRows] = useState<DeskPayoutRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const from = useMemo(() => periodStart(period), [period]);
  // 0040: the day desks are paid on — a promise the desks' Takings and the
  // terms both read from the same row.
  const [payoutDay, setPayoutDayState] = useState<number | null>(null);
  const [savingDay, setSavingDay] = useState(false);
  useEffect(() => {
    void platformSettings().then((s) => setPayoutDayState(s.payout_weekday));
  }, []);
  async function changeDay(weekday: number) {
    setSavingDay(true);
    setError(null);
    try {
      await setPayoutDay(weekday);
      setPayoutDayState(weekday);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't set the payout day.");
    } finally {
      setSavingDay(false);
    }
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await adminPayoutDesks(from));
    } catch (e) {
      // Before 0035 there's nothing to show and nothing to say.
      setRows([]);
      setError(/could not find|does not exist|schema cache/i.test(e instanceof Error ? e.message : "") ? null : (e instanceof Error ? e.message : "Couldn't read payouts."));
    }
  }, [from]);

  useEffect(() => {
    void load();
  }, [load]);

  const relevant = (rows ?? []).filter((d) => d.gateway_status === "collect" || d.owed > 0 || d.paid_out > 0);
  if (rows !== null && relevant.length === 0 && !error) return null;

  const totals = {
    gross: relevant.reduce((n, d) => n + d.gross, 0),
    fee: relevant.reduce((n, d) => n + d.fee, 0),
    balance: relevant.reduce((n, d) => n + d.balance, 0),
  };

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-heading m-0 text-[18px] font-bold">Payouts to desks</h2>
          <p className="m-0 mt-0.5 text-[12.5px] text-muted">
            Online payments land with Printifi; each desk&apos;s share is owed to it until you send it and record it here.
          </p>
          <label className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="text-muted">Desks are paid every</span>
            <select
              value={payoutDay ?? 1}
              disabled={payoutDay === null || savingDay}
              onChange={(e) => void changeDay(Number(e.target.value))}
              className="rounded-lg border border-line bg-surface-sunk px-2 py-1 text-[12.5px] font-semibold outline-none focus:border-ink disabled:opacity-60"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i + 1}>{d}</option>
              ))}
            </select>
            {payoutDay && (
              <span className="text-muted">
                — next {nextPayoutDate(payoutDay).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}. Every
                desk sees this day in Takings and in the terms.
              </span>
            )}
          </label>
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
      {rows === null ? (
        <p className="m-0 mt-3 flex items-center gap-2 text-[12.5px] text-muted">
          <Loader2 size={14} className="animate-spin" />
          Reading…
        </p>
      ) : (
        <>
          <dl className="m-0 mt-3.5 grid gap-2 sm:grid-cols-3">
            <Stat label={`Collected online ${PERIODS.find((p) => p.id === period)?.label.toLowerCase()}`} value={money(totals.gross)} />
            <Stat label="Your fee on those" value={money(totals.fee)} />
            <Stat label="Owed to desks, all time" value={money(totals.balance)} strong />
          </dl>
          <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
            {relevant.map((d) => (
              <DeskRow key={d.operator_id} desk={d} periodLabel={PERIODS.find((p) => p.id === period)?.label ?? ""} onRecorded={load} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function DeskRow({ desk, periodLabel, onRecorded }: { desk: DeskPayoutRow; periodLabel: string; onRecorded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function record() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await recordPayout(desk.operator_id, Math.round(value * 100) / 100, note);
      setAmount("");
      setNote("");
      setOpen(false);
      await onRecorded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-line bg-surface-sunk px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{desk.name}</span>
          <span className="block font-mono text-[11px] text-muted">
            {desk.orders} online {periodLabel.toLowerCase()} · {money(desk.gross)} collected · fee {money(desk.fee)} · desk&apos;s share{" "}
            {money(desk.share)} · paid out {money(desk.paid_out)} all time
          </span>
        </span>
        <span className="text-right">
          <span className="block text-[10.5px] text-muted">owed to desk</span>
          <span className={cn("font-figure block text-[18px] font-extrabold tabular-nums", desk.balance > 0 ? "" : "text-sage-ink")}>
            {money(desk.balance)}
          </span>
        </span>
        <button
          onClick={() => {
            setOpen((o) => !o);
            if (!open && desk.balance > 0) setAmount(desk.balance.toFixed(2));
          }}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12px] font-semibold text-ink-soft"
        >
          {open ? <X size={13} strokeWidth={2.2} /> : <Send size={13} strokeWidth={2.2} />}
          {open ? "Cancel" : "Record payout"}
        </button>
      </div>

      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void record();
          }}
          className="mt-2.5 flex flex-wrap gap-2 border-t border-line pt-2.5"
        >
          <p className="m-0 w-full text-[11.5px] leading-relaxed text-muted">
            Send the money first — UPI or bank, to whatever the desk gave you. This only writes it down; the desk sees it on
            its Takings.
          </p>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            inputMode="decimal"
            placeholder="Amount sent"
            aria-label="Amount sent"
            className="h-10 w-40 rounded-lg border border-line bg-surface px-3 font-mono text-[13px] outline-none focus:border-ink"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Note — e.g. week 37, UPI ref 4231…"
            aria-label="Note"
            className="h-10 min-w-[160px] flex-1 rounded-lg border border-line bg-surface px-3 text-[13px] outline-none focus:border-ink"
          />
          <button
            type="submit"
            disabled={busy || !amount}
            className="flex h-10 items-center gap-1.5 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.6} />}
            Record
          </button>
          {error && <p className="m-0 w-full text-[12px] text-clay-ink dark:text-clay">{error}</p>}
        </form>
      )}
    </li>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-[14px] border border-line p-3", strong ? "bg-ink text-paper" : "bg-surface-sunk")}>
      <dt className={cn("text-[11.5px]", strong ? "text-paper/70" : "text-muted")}>{label}</dt>
      <dd className="font-figure m-0 mt-0.5 text-[20px] font-extrabold tabular-nums">{value}</dd>
    </div>
  );
}
