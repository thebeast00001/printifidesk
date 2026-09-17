"use client";

import { useEffect, useState } from "react";
import { Banknote, Check, Loader2 } from "lucide-react";
import { adminCashReport, platformSettings, setCashPolicy, type CashPolicy, type CashReport } from "@/lib/platform";
import { money } from "@/lib/pricing";

/**
 * Cash as a credit line (0043): the numbers the rule runs on, and what it
 * has cost and recovered so far.
 *
 * The exposure is what a student can walk away with — one order, at most
 * the starting limit, before the door shuts. The report is the platform's
 * own ledger: dues outstanding across every student, what Printifi has
 * covered for desks, and what came back — online, and in cash at desks.
 */
export function AdminCash() {
  const [policy, setPolicy] = useState<CashPolicy | null>(null);
  const [draft, setDraft] = useState<CashPolicy | null>(null);
  const [report, setReport] = useState<CashReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void platformSettings(true).then((s) => {
      const p = { start: s.cash_limit_start, step: s.cash_limit_step, cap: s.cash_limit_cap, strikes: s.cash_strikes_allowed, lockoutDays: s.cash_lockout_days };
      setPolicy(p);
      setDraft(p);
    });
    void adminCashReport().then(setReport);
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setCashPolicy(draft);
      setPolicy(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the policy.");
    } finally {
      setSaving(false);
    }
  }

  const dirty = policy && draft && JSON.stringify(policy) !== JSON.stringify(draft);

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <h2 className="font-heading m-0 flex items-center gap-2 text-[18px] font-bold">
        <Banknote size={17} strokeWidth={2.2} />
        Cash on credit
      </h2>
      <p className="m-0 mt-0.5 text-[12.5px] leading-relaxed text-muted">
        Every order prints at once. Cash is allowed within a limit that grows as a student collects; an uncollected cash
        order becomes dues on their account (no orders anywhere until paid), a strike, and a credit to the desk —
        Printifi covers the desk&apos;s price for the job and recovers it from the student.
      </p>

      {report && (
        <dl className="m-0 mt-3.5 grid gap-2 sm:grid-cols-4">
          <Stat label="Dues outstanding" value={money(report.dues_outstanding)} sub={`${report.students_with_dues} ${report.students_with_dues === 1 ? "student" : "students"} · ${report.students_blocked} cash-blocked`} strong />
          <Stat label="Covered for desks" value={money(report.covered)} sub={`${report.covered_orders} uncollected cash ${report.covered_orders === 1 ? "order" : "orders"}`} />
          <Stat label="Recovered online" value={money(report.recovered_online)} sub="paid through Printifi" />
          <Stat label="Recovered in cash" value={money(report.recovered_cash)} sub="taken at desks, owed on to Printifi" />
        </dl>
      )}

      {draft && (
        <div className="mt-4 grid gap-3 sm:grid-cols-5">
          <Field label="Starting limit" prefix="₹" value={draft.start} onChange={(v) => setDraft({ ...draft, start: v })} hint="a new account's cash per order" />
          <Field label="Grows by" prefix="₹" value={draft.step} onChange={(v) => setDraft({ ...draft, step: v })} hint="per cash order collected" />
          <Field label="Up to" prefix="₹" value={draft.cap} onChange={(v) => setDraft({ ...draft, cap: v })} hint="the most any student gets" />
          <Field label="Strikes" value={draft.strikes} onChange={(v) => setDraft({ ...draft, strikes: v })} hint="uncollected orders before cash is off" />
          <Field label="Cash off for" suffix="days" value={draft.lockoutDays} onChange={(v) => setDraft({ ...draft, lockoutDays: v })} hint="after the last strike" />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} strokeWidth={2.6} /> : null}
          {saved ? "Saved" : "Save policy"}
        </button>
        {draft && (
          <span className="text-[12px] text-muted">
            Worst case per new student: one order of {money(draft.start)}, then the door shuts until it&apos;s paid.
          </span>
        )}
        {error && <span className="text-[12px] text-clay-ink dark:text-clay">{error}</span>}
      </div>
    </section>
  );
}

function Stat({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className="rounded-[14px] border border-line bg-surface-sunk px-3.5 py-3">
      <dt className="m-0 text-[10.5px] font-semibold tracking-[0.06em] text-muted uppercase">{label}</dt>
      <dd className={`m-0 mt-0.5 font-mono tabular-nums ${strong ? "text-[20px] font-semibold" : "text-[16px]"}`}>{value}</dd>
      {sub && <dd className="m-0 mt-0.5 text-[11.5px] text-muted">{sub}</dd>}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  prefix,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint: string;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-semibold text-ink-soft">{label}</span>
      <span className="flex items-center gap-1 rounded-xl border border-line bg-surface-sunk px-2.5 py-2 font-mono text-[13px] focus-within:border-ink">
        {prefix && <span className="text-muted">{prefix}</span>}
        <input
          type="number"
          inputMode="numeric"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full min-w-0 bg-transparent outline-none"
        />
        {suffix && <span className="text-muted">{suffix}</span>}
      </span>
      <span className="text-[11px] text-muted">{hint}</span>
    </label>
  );
}
