"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Check, Loader2, Receipt, X } from "lucide-react";
import {
  adminFeeDesks,
  periodStart,
  platformSettings,
  recordSettlement,
  adminFeeOrders,
  type FeeOrderRow,
  setPlatformFee,
  type DeskFeeRow,
  type FeePeriod,
  type PlatformSettings,
} from "@/lib/platform";
import { money } from "@/lib/pricing";
import { normaliseVpa, vpaProblem, type UpiKind } from "@/lib/upi";
import { cn, spring } from "@/lib/utils";

const PERIODS: { id: FeePeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
];

/**
 * Printifi's side of the fee.
 *
 * The rate and where desks settle to, the total across every desk for
 * today / this week / this month, and each desk's balance with a way to
 * record a payment received. Every figure is `admin_fee_desks()` —
 * collected, unrefunded orders, to the paisa — and recording a payment is
 * the admin saying "this arrived in my UPI", the same trust model as cash
 * at a counter. Only the admin can call any of it; the database enforces
 * that, not this component.
 */
export function AdminFees() {
  const [period, setPeriod] = useState<FeePeriod>("today");
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [rows, setRows] = useState<DeskFeeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const from = useMemo(() => periodStart(period), [period]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ps, desks] = await Promise.all([platformSettings(true), adminFeeDesks(from)]);
      setSettings(ps);
      setRows(desks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the fee ledger.");
      setRows([]);
    }
  }, [from]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const r = rows ?? [];
    return {
      orders: r.reduce((n, d) => n + d.orders, 0),
      fee: r.reduce((n, d) => n + d.fee, 0),
      retained: r.reduce((n, d) => n + d.retained, 0),
      outstanding: r.reduce((n, d) => n + d.outstanding, 0),
      settled: r.reduce((n, d) => n + d.settled, 0),
    };
  }, [rows]);

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading m-0 flex items-center gap-2 text-[18px] font-bold">
          <Receipt size={16} strokeWidth={2.2} />
          Platform fee
        </h2>
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
                <motion.span layoutId="admin-fee-period" transition={spring} className="absolute inset-0 rounded-full bg-ink" />
              )}
              <span className="relative">{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      {error && <p className="m-0 mb-3 text-[12.5px] text-clay-ink dark:text-clay">{error}</p>}

      {rows === null ? (
        <p className="m-0 flex items-center gap-2 py-3 text-[13px] text-muted">
          <Loader2 size={15} className="animate-spin" />
          Counting…
        </p>
      ) : (
        <>
          <dl className="m-0 grid gap-2 sm:grid-cols-4">
            <Stat label={`Orders ${PERIODS.find((p) => p.id === period)?.label.toLowerCase()}`} value={String(totals.orders)} />
            <Stat label="Fee earned" value={money(totals.fee + totals.retained)} strong sub={totals.retained > 0 ? `${money(totals.retained)} taken at source` : undefined} />
            <Stat label="Settled, all time" value={money(totals.settled)} />
            <Stat label="Outstanding, all time" value={money(totals.outstanding)} />
          </dl>
          <p className="m-0 mt-2 font-mono text-[11px] text-muted">
            across every desk · collected orders, not fully refunded · in your own time zone
          </p>

          <div className="mt-4">
            <p className="label-caps m-0 mb-1.5">By desk</p>
            {rows.length === 0 ? (
              <p className="m-0 text-[12.5px] text-muted">No desks yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {rows.map((d) => (
                  <DeskRow
                    key={d.operator_id}
                    desk={d}
                    from={from}
                    periodLabel={PERIODS.find((p) => p.id === period)?.label ?? ""}
                    onRecorded={load}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {settings && <SettingsForm settings={settings} onSaved={load} />}
    </section>
  );
}

function DeskRow({
  desk,
  from,
  periodLabel,
  onRecorded,
}: {
  desk: DeskFeeRow;
  from: Date;
  periodLabel: string;
  onRecorded: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The period's orders, one line each, loaded when the admin asks.
  const [orders, setOrders] = useState<FeeOrderRow[] | null>(null);
  const [showOrders, setShowOrders] = useState(false);

  useEffect(() => {
    setOrders(null);
    setShowOrders(false);
  }, [from, desk.operator_id]);

  async function toggleOrders() {
    if (showOrders) return setShowOrders(false);
    setShowOrders(true);
    if (orders === null) {
      try {
        setOrders(await adminFeeOrders(desk.operator_id, from));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't list the orders.");
        setOrders([]);
      }
    }
  }

  async function record() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await recordSettlement(desk.operator_id, Math.round(value * 100) / 100, note);
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
            {desk.orders} collected · fee {money(desk.fee)}
            {desk.retained > 0 ? ` + ${money(desk.retained)} at source` : ""} · settled {money(desk.settled)}
            {desk.gateway_status === "active" ? " · online payments on" : desk.gateway_status === "pending" ? " · online payments pending" : ""}
          </span>
        </span>
        <span className="text-right">
          <span className="block text-[10.5px] text-muted">outstanding</span>
          <span className={cn("font-figure block text-[18px] font-extrabold tabular-nums", desk.outstanding > 0 ? "" : "text-sage-ink")}>
            {money(desk.outstanding)}
          </span>
        </span>
        <button
          onClick={() => void toggleOrders()}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12px] font-semibold text-ink-soft"
        >
          <Receipt size={13} strokeWidth={2.2} />
          {showOrders ? "Hide orders" : `Orders ${periodLabel.toLowerCase()}`}
        </button>
        <button
          onClick={() => {
            setOpen((o) => !o);
            if (!open && desk.outstanding > 0) setAmount(desk.outstanding.toFixed(2));
          }}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12px] font-semibold text-ink-soft"
        >
          {open ? <X size={13} strokeWidth={2.2} /> : <Check size={13} strokeWidth={2.4} />}
          {open ? "Cancel" : "Record payment"}
        </button>
      </div>

      {showOrders && (
        <div className="mt-2.5 border-t border-line pt-2.5">
          {orders === null ? (
            <p className="m-0 flex items-center gap-2 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" />
              Reading the orders…
            </p>
          ) : orders.length === 0 ? (
            <p className="m-0 text-[12px] text-muted">No collected orders {periodLabel.toLowerCase()}.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="text-left text-[10.5px] tracking-[0.08em] text-muted uppercase">
                    <th className="py-1 pr-3 font-semibold">Token</th>
                    <th className="py-1 pr-3 font-semibold">Collected</th>
                    <th className="py-1 pr-3 font-semibold">Paid</th>
                    <th className="py-1 pr-3 text-right font-semibold">Bill</th>
                    <th className="py-1 text-right font-semibold">Fee</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {orders.map((o) => (
                    <tr key={o.id} className="border-t border-line/60">
                      <td className="py-1.5 pr-3 font-semibold">{o.token ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-muted">
                        {new Date(o.collected_at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                      </td>
                      <td className="py-1.5 pr-3 text-muted">
                        {o.payment_method === "gateway" ? "online" : (o.payment_method ?? "—")}
                        {o.refund_amount ? ` · refunded ${money(o.refund_amount)}` : ""}
                      </td>
                      <td className="py-1.5 pr-3 text-right">{money(o.total)}</td>
                      <td className={cn("py-1.5 text-right font-semibold", o.fee_settled_at ? "text-muted" : "")}>
                        {money(o.platform_fee)}
                        {o.fee_settled_at ? <span className="ml-1 font-sans text-[10px] font-normal">at source</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line font-sans">
                    <td colSpan={4} className="py-1.5 pr-3 text-[11.5px] text-muted">
                      {orders.length} {orders.length === 1 ? "order" : "orders"} {periodLabel.toLowerCase()} — the desk owes the fee on those not marked at source
                    </td>
                    <td className="py-1.5 text-right font-mono text-[13px] font-extrabold tabular-nums">
                      {money(orders.filter((o) => !o.fee_settled_at).reduce((n, o) => n + o.platform_fee, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void record();
          }}
          className="mt-2.5 flex flex-wrap gap-2 border-t border-line pt-2.5"
        >
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            inputMode="decimal"
            placeholder="Amount received"
            aria-label="Amount received"
            className="h-10 w-40 rounded-lg border border-line bg-surface px-3 font-mono text-[13px] outline-none focus:border-ink"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Note — e.g. September, UPI ref 4231…"
            aria-label="Note"
            className="h-10 min-w-[160px] flex-1 rounded-lg border border-line bg-surface px-3 text-[13px] outline-none focus:border-ink"
          />
          <button
            type="submit"
            disabled={busy || !(Number(amount) > 0)}
            className="flex h-10 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[12.5px] font-semibold text-paper disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.6} />}
            Received
          </button>
          {error && <p className="m-0 basis-full text-[12px] text-clay-ink dark:text-clay">{error}</p>}
        </form>
      )}
    </li>
  );
}

function SettingsForm({ settings, onSaved }: { settings: PlatformSettings; onSaved: () => Promise<void> }) {
  const [percent, setPercent] = useState(String(settings.fee_percent));
  const [min, setMin] = useState(String(settings.fee_min));
  const [vpa, setVpa] = useState(settings.payee_vpa ?? "");
  const [name, setName] = useState(settings.payee_name ?? "");
  const [payeeKind, setPayeeKind] = useState<UpiKind>(settings.payee_kind);
  const [grace, setGrace] = useState(String(settings.grace_days));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPercent(String(settings.fee_percent));
    setMin(String(settings.fee_min));
    setVpa(settings.payee_vpa ?? "");
    setName(settings.payee_name ?? "");
    setPayeeKind(settings.payee_kind);
    setGrace(String(settings.grace_days));
  }, [settings]);

  const dirty =
    Number(percent) !== settings.fee_percent ||
    Number(min) !== settings.fee_min ||
    vpa.trim() !== (settings.payee_vpa ?? "") ||
    name.trim() !== (settings.payee_name ?? "") ||
    payeeKind !== settings.payee_kind ||
    Number(grace) !== settings.grace_days;
  const vpaWhy = vpaProblem(vpa);
  const vpaOk = vpaWhy === null;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await setPlatformFee({ percent: Number(percent), min: Number(min), vpa: normaliseVpa(vpa), name, graceDays: Number(grace), payeeKind });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="mt-4 rounded-[16px] border border-line bg-surface-sunk p-4"
    >
      <p className="label-caps m-0">The rate</p>
      <p className="m-0 mt-1 mb-3 max-w-[60ch] text-[12.5px] leading-relaxed text-muted">
        A percentage of each order after the desk&apos;s minimum, shown on the student&apos;s bill. Changing it
        touches orders placed from now on — every order keeps the rate it was priced at. Desks settle to the
        VPA below; it appears on their Takings page with a QR. Fees on a month&apos;s orders are due when the
        month ends; a desk that hasn&apos;t settled by the grace day can&apos;t open until it does.
      </p>
      <div className="grid gap-2 sm:grid-cols-[auto_auto_auto_1fr_1fr_auto]">
        <label className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[13px]">
          <input
            value={percent}
            onChange={(e) => setPercent(e.target.value.replace(/[^\d.]/g, ""))}
            inputMode="decimal"
            aria-label="Fee percent"
            className="w-12 bg-transparent font-mono text-[14px] outline-none"
          />
          <span className="text-muted">%</span>
        </label>
        <label className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[13px]">
          <span className="text-muted">min ₹</span>
          <input
            value={min}
            onChange={(e) => setMin(e.target.value.replace(/[^\d.]/g, ""))}
            inputMode="decimal"
            aria-label="Minimum fee"
            className="w-12 bg-transparent font-mono text-[14px] outline-none"
          />
        </label>
        <label className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[13px]">
          <span className="text-muted">grace</span>
          <input
            value={grace}
            onChange={(e) => setGrace(e.target.value.replace(/\D/g, "").slice(0, 2))}
            inputMode="numeric"
            aria-label="Grace days"
            className="w-8 bg-transparent font-mono text-[14px] outline-none"
          />
          <span className="text-muted">days</span>
        </label>
        <input
          value={vpa}
          onChange={(e) => setVpa(e.target.value)}
          placeholder="Your UPI id, e.g. printify@upi"
          aria-label="Payee VPA"
          spellCheck={false}
          className={cn(
            "h-11 min-w-0 rounded-xl border bg-surface px-3 font-mono text-[13px] outline-none focus:border-ink",
            vpaOk ? "border-line" : "border-clay",
          )}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="Payee name shown in UPI apps"
          aria-label="Payee name"
          className="h-11 min-w-0 rounded-xl border border-line bg-surface px-3 text-[13px] outline-none focus:border-ink"
        />
        <label className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[13px]">
          <span className="text-muted">id is</span>
          <select
            value={payeeKind}
            onChange={(e) => setPayeeKind(e.target.value as UpiKind)}
            aria-label="Payee id kind"
            title="A business-QR id takes the amount pre-filled in the desk's settle-up link; a personal id can't, so the desk types it"
            className="bg-transparent font-semibold outline-none"
          >
            <option value="personal">personal</option>
            <option value="merchant">business QR</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !dirty || !vpaOk || percent === "" || min === "" || grace === ""}
          className={cn(
            "flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[13px] font-semibold disabled:opacity-40",
            dirty ? "bg-ink text-paper" : "border border-line text-faint",
          )}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} strokeWidth={2.6} />}
          {saved ? "Saved" : "Save"}
        </button>
      </div>
      {!vpaOk && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{vpaWhy}</p>}
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </form>
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
