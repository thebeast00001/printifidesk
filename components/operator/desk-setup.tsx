"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { updateOperator, type Operator, type OperatorSettings } from "@/lib/orders";
import { DAY_KEYS, DAY_LABEL, hoursOn, type DayKey, type WeeklyHours } from "@/lib/hours";
import { extrasOf, money, type Extra } from "@/lib/pricing";
import { cn, spring } from "@/lib/utils";

/**
 * Three of the owner's settings (0039), each its own small form with its
 * own save: hours by weekday and days closed; the desk's extras; and the
 * two windows after which an order is given up on. Every one is written
 * to the desk's row, read back by the database's own functions, and
 * refused there for anyone but the owner — the forms are the owner's
 * view of the same rule, not the rule.
 */

/* ---------- a save button, the same on each form ---------- */

function SaveButton({ dirty, valid, saving, saved, onClick, label }: {
  dirty: boolean;
  valid: boolean;
  saving: boolean;
  saved: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <motion.button
      whileTap={{ scale: dirty && valid ? 0.96 : 1 }}
      transition={spring}
      disabled={!dirty || !valid || saving}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-colors",
        dirty && valid ? "bg-ink text-paper" : "border border-line text-faint",
      )}
    >
      {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} strokeWidth={2.6} /> : null}
      {saving ? "Saving…" : saved ? "Saved" : label}
    </motion.button>
  );
}

function useSave(onSaved: () => void) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(write: () => Promise<void>, fallback: string) {
    setSaving(true);
    setError(null);
    try {
      await write();
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setSaving(false);
    }
  }
  return { saving, saved, error, run };
}

/* ---------- hours by weekday, days closed ---------- */

interface DayDraft {
  open: string;
  close: string;
  closed: boolean;
}

function draftFrom(operator: Operator): Record<DayKey, DayDraft> {
  const out = {} as Record<DayKey, DayDraft>;
  for (const day of DAY_KEYS) {
    const h = hoursOn(operator, day);
    out[day] = h
      ? { open: h.open, close: h.close, closed: false }
      : { open: (operator.opens_at ?? "09:00").slice(0, 5), close: (operator.closes_at ?? "18:00").slice(0, 5), closed: true };
  }
  return out;
}

const sameDraft = (a: Record<DayKey, DayDraft>, b: Record<DayKey, DayDraft>) =>
  DAY_KEYS.every((d) => a[d].open === b[d].open && a[d].close === b[d].close && a[d].closed === b[d].closed);

export function WeeklyHoursSettings({ operator, onSaved }: { operator: Operator; onSaved: () => void }) {
  const initial = useMemo(() => draftFrom(operator), [operator]);
  const [days, setDays] = useState(initial);
  const [closedOn, setClosedOn] = useState<string[]>(operator.closed_on ?? []);
  const [newDate, setNewDate] = useState("");
  const { saving, saved, error, run } = useSave(onSaved);

  useEffect(() => {
    setDays(initial);
    setClosedOn(operator.closed_on ?? []);
  }, [initial, operator.closed_on]);

  const set = (day: DayKey, patch: Partial<DayDraft>) => setDays((d) => ({ ...d, [day]: { ...d[day], ...patch } }));
  const copyMondayToWeekdays = () =>
    setDays((d) => {
      const next = { ...d };
      for (const day of ["tue", "wed", "thu", "fri"] as DayKey[]) next[day] = { ...d.mon };
      return next;
    });

  const valid = DAY_KEYS.every((d) => days[d].closed || (/^\d\d:\d\d$/.test(days[d].open) && /^\d\d:\d\d$/.test(days[d].close) && days[d].open !== days[d].close));
  const anyOpen = DAY_KEYS.some((d) => !days[d].closed);
  const dirty =
    !sameDraft(days, initial) ||
    closedOn.length !== (operator.closed_on ?? []).length ||
    closedOn.some((x) => !(operator.closed_on ?? []).includes(x));

  function save() {
    const hours: WeeklyHours = {};
    for (const d of DAY_KEYS) hours[d] = days[d].closed ? null : { open: days[d].open, close: days[d].close };
    // opens_at/closes_at stay as the fallback older readers use: the first open day's.
    const first = DAY_KEYS.map((d) => days[d]).find((x) => !x.closed);
    void run(
      () =>
        updateOperator(operator.id, {
          hours,
          closed_on: [...closedOn].sort(),
          ...(first ? { opens_at: `${first.open}:00`, closes_at: `${first.close}:00` } : {}),
        } as OperatorSettings),
      "Couldn't save the hours.",
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mt-5 border-t border-line pt-5">
      <p className="label-caps m-0 mb-2">Hours</p>
      <p className="m-0 mb-3 max-w-[60ch] text-[11.5px] leading-relaxed text-muted">
        Each day&apos;s own hours. Outside them the desk shows as closed and students see when it opens next;
        inside them the <b className="font-semibold">Open</b> switch still has the last word. Hours past midnight
        (6 PM to 2 AM) are fine.
      </p>

      <div className="flex flex-col gap-1.5">
        {DAY_KEYS.map((day) => {
          const d = days[day];
          return (
            <div key={day} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
              <label className="flex w-[118px] items-center gap-2 text-[12.5px] font-semibold">
                <input type="checkbox" checked={!d.closed} onChange={(e) => set(day, { closed: !e.target.checked })} className="accent-ink" />
                {DAY_LABEL[day]}
              </label>
              {d.closed ? (
                <span className="text-[12px] text-muted">Closed</span>
              ) : (
                <>
                  <input
                    type="time"
                    value={d.open}
                    onChange={(e) => set(day, { open: e.target.value })}
                    className="rounded-lg border border-line bg-surface-sunk px-2 py-1 font-mono text-[12.5px] outline-none focus:border-ink"
                  />
                  <span className="text-[12px] text-muted">to</span>
                  <input
                    type="time"
                    value={d.close}
                    onChange={(e) => set(day, { close: e.target.value })}
                    className="rounded-lg border border-line bg-surface-sunk px-2 py-1 font-mono text-[12.5px] outline-none focus:border-ink"
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      <button onClick={copyMondayToWeekdays} className="mt-2 text-[12px] font-semibold text-muted underline-offset-2 hover:underline">
        Use Monday&apos;s hours Tuesday to Friday
      </button>

      <p className="label-caps m-0 mt-5 mb-2">Days closed</p>
      <p className="m-0 mb-2 max-w-[60ch] text-[11.5px] leading-relaxed text-muted">
        Holidays and one-offs. The desk shows as closed all day; students can still order for a later pickup.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {closedOn.map((d) => (
          <span key={d} className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 font-mono text-[12px]">
            {d}
            <button onClick={() => setClosedOn((c) => c.filter((x) => x !== d))} aria-label={`Open on ${d}`} className="text-muted hover:text-ink">
              <X size={12} strokeWidth={2.4} />
            </button>
          </span>
        ))}
        <input
          type="date"
          value={newDate}
          min={today}
          onChange={(e) => setNewDate(e.target.value)}
          className="rounded-lg border border-line bg-surface-sunk px-2 py-1.5 font-mono text-[12.5px] outline-none focus:border-ink"
        />
        <button
          disabled={!newDate || closedOn.includes(newDate) || closedOn.length >= 60}
          onClick={() => {
            setClosedOn((c) => [...c, newDate]);
            setNewDate("");
          }}
          className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-40"
        >
          <Plus size={12} strokeWidth={2.6} />
          Add
        </button>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <SaveButton dirty={dirty} valid={valid && anyOpen} saving={saving} saved={saved} onClick={save} label="Save hours" />
        {!anyOpen && <span className="text-[11.5px] text-clay-ink dark:text-clay">At least one day needs hours.</span>}
      </div>
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </div>
  );
}

/* ---------- extras ---------- */

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "extra";

export function ExtrasSettings({ operator, onSaved }: { operator: Operator; onSaved: () => void }) {
  const initial = useMemo(() => extrasOf(operator.extras), [operator.extras]);
  const [rows, setRows] = useState<Extra[]>(initial);
  const { saving, saved, error, run } = useSave(onSaved);

  useEffect(() => setRows(initial), [initial]);

  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);
  const valid = rows.every((r) => r.name.trim().length > 0 && r.name.length <= 40 && Number.isFinite(r.price) && r.price >= 0 && r.price <= 5000);

  function add() {
    if (rows.length >= 12) return;
    setRows((r) => [...r, { id: "", name: "", price: 0, per: "copy" }]);
  }
  function update(i: number, patch: Partial<Extra>) {
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  function save() {
    // Ids stay once made; a new one comes from the name, kept unique.
    const taken = new Set<string>();
    const cleaned: Extra[] = rows.map((r) => {
      let id = r.id || slug(r.name);
      let n = 2;
      while (taken.has(id)) id = `${slug(r.name)}-${n++}`.slice(0, 40);
      taken.add(id);
      return { id, name: r.name.trim(), price: Math.round(r.price * 100) / 100, per: r.per };
    });
    void run(() => updateOperator(operator.id, { extras: cleaned } as OperatorSettings), "Couldn't save the extras.");
  }

  return (
    <div className="mt-5 border-t border-line pt-5">
      <p className="label-caps m-0 mb-2">Extras</p>
      <p className="m-0 mb-3 max-w-[60ch] text-[11.5px] leading-relaxed text-muted">
        What you do besides printing — spiral binding, lamination, A3, thick paper — in your own words and at your own
        price, <b className="font-semibold">per copy</b> of a file or <b className="font-semibold">once per job</b>. Students pick them
        per file; the bill shows each by name. Up to twelve.
      </p>

      <div className="flex flex-col gap-1.5">
        {rows.map((r, i) => (
          <div key={r.id || `new-${i}`} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
            <input
              value={r.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="Spiral binding"
              maxLength={40}
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 text-[13px] outline-none focus:border-ink"
            />
            <label className="flex items-center gap-1 text-[12.5px]">
              <span className="text-muted">{operator.currency || "₹"}</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={5000}
                step="0.5"
                value={Number.isFinite(r.price) ? r.price : ""}
                onChange={(e) => update(i, { price: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
                className="w-[84px] rounded-lg border border-line bg-surface-sunk px-2 py-1.5 font-mono text-[13px] outline-none focus:border-ink"
              />
            </label>
            <select
              value={r.per}
              onChange={(e) => update(i, { per: e.target.value as Extra["per"] })}
              className="rounded-lg border border-line bg-surface-sunk px-2 py-1.5 text-[12.5px] outline-none focus:border-ink"
            >
              <option value="copy">per copy</option>
              <option value="job">per job</option>
            </select>
            <button onClick={() => setRows((x) => x.filter((_, j) => j !== i))} aria-label={`Remove ${r.name || "extra"}`} className="text-muted hover:text-ink">
              <X size={14} strokeWidth={2.4} />
            </button>
          </div>
        ))}
        {rows.length === 0 && <p className="m-0 text-[12px] text-muted">No extras yet — printing only.</p>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={add}
          disabled={rows.length >= 12}
          className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-[12.5px] font-semibold disabled:opacity-40"
        >
          <Plus size={13} strokeWidth={2.6} />
          Add an extra
        </button>
        <SaveButton dirty={dirty} valid={valid} saving={saving} saved={saved} onClick={save} label="Save extras" />
      </div>
      {rows.length > 0 && valid && (
        <p className="m-0 mt-2 text-[11.5px] text-muted">
          On the sheet: {rows.map((r) => `${r.name.trim() || "…"} +${money(r.price || 0, operator.currency)}${r.per === "copy" ? "/copy" : ""}`).join(" · ")}
        </p>
      )}
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </div>
  );
}

/* ---------- the two windows ---------- */

const UNPAID = [
  [0, "Never"],
  [30, "30 minutes"],
  [60, "1 hour"],
  [120, "2 hours"],
  [240, "4 hours"],
  [480, "8 hours"],
  [1440, "a day"],
] as const;
const UNCLAIMED = [
  [0, "Never"],
  [24, "1 day"],
  [48, "2 days"],
  [72, "3 days"],
  [168, "a week"],
  [336, "two weeks"],
] as const;

export function WindowsSettings({ operator, onSaved }: { operator: Operator; onSaved: () => void }) {
  const [unpaid, setUnpaid] = useState(operator.unpaid_expiry_minutes ?? 120);
  const [unclaimed, setUnclaimed] = useState(operator.unclaimed_after_hours ?? 48);
  const { saving, saved, error, run } = useSave(onSaved);

  useEffect(() => {
    setUnpaid(operator.unpaid_expiry_minutes ?? 120);
    setUnclaimed(operator.unclaimed_after_hours ?? 48);
  }, [operator.unpaid_expiry_minutes, operator.unclaimed_after_hours]);

  const dirty = unpaid !== (operator.unpaid_expiry_minutes ?? 120) || unclaimed !== (operator.unclaimed_after_hours ?? 48);

  return (
    <div className="mt-5 border-t border-line pt-5">
      <p className="label-caps m-0 mb-2">Orders that go nowhere</p>
      <p className="m-0 mb-3 max-w-[60ch] text-[11.5px] leading-relaxed text-muted">
        An order nobody paid for is cancelled after the first window, and told so. A job marked ready that nobody
        collected is cleared after the second: its shelf slot frees, its files are deleted, and what you were paid stays
        yours — you printed it. Both run when this page loads and once a day.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold tracking-[-0.01em]">Unpaid orders expire after</span>
          <select
            value={unpaid}
            onChange={(e) => setUnpaid(Number(e.target.value))}
            className="rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 text-[13px] outline-none focus:border-ink"
          >
            {UNPAID.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold tracking-[-0.01em]">Ready jobs count as unclaimed after</span>
          <select
            value={unclaimed}
            onChange={(e) => setUnclaimed(Number(e.target.value))}
            className="rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 text-[13px] outline-none focus:border-ink"
          >
            {UNCLAIMED.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </label>
        <SaveButton
          dirty={dirty}
          valid
          saving={saving}
          saved={saved}
          onClick={() =>
            void run(
              () => updateOperator(operator.id, { unpaid_expiry_minutes: unpaid, unclaimed_after_hours: unclaimed } as OperatorSettings),
              "Couldn't save.",
            )
          }
          label="Save"
        />
      </div>
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </div>
  );
}

/* ---------- payments through Printifi: the owner's switch ---------- */

/**
 * Payments through Printifi (0040). Switching them on is the admin's — it
 * commits Printifi's account — but pausing them is the owner's, at any
 * moment: students pay the desk directly meanwhile, and nothing else
 * changes. "You're never locked in" is most of what a shop wants to hear.
 */
export function OnlinePaymentsSwitch({ operator, onSaved }: { operator: Operator; onSaved: () => void }) {
  const { saving, saved, error, run } = useSave(onSaved);
  const status = operator.gateway_status ?? "off";
  const live = status === "collect" || status === "active";
  const paused = operator.gateway_paused === true;

  return (
    <div className="mt-5 border-t border-line pt-5">
      <p className="label-caps m-0 mb-2">Payments through Printifi</p>
      {!live ? (
        <p className="m-0 max-w-[60ch] text-[11.5px] leading-relaxed text-muted">
          {status === "pending"
            ? "Being set up — Printifi is verifying the account it will pay you into."
            : status === "blocked"
              ? "Printifi couldn't verify the payout account. Ask on the support line below."
              : "Not switched on for this desk. Students pay your UPI id directly — the money is yours instantly and Printifi never holds it. Ask Printifi to switch on card and any-app UPI payments through its checkout if you want them; you can pause them yourself at any time."}
        </p>
      ) : (
        <>
          <p className="m-0 max-w-[60ch] text-[11.5px] leading-relaxed text-muted">
            Students can pay by card or any UPI app through Printifi&apos;s checkout; the order queues itself the moment
            the money lands and your share is paid out to you on the payout day — every order and every payout is
            listed under Takings. <b className="font-semibold">Pause it whenever you like</b>: students then pay your
            UPI id directly, as always, until you switch it back on.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold", paused ? "bg-clay text-clay-ink" : "bg-sage text-sage-ink")}>
              {paused ? "Paused — students pay you directly" : "On — students can pay through Printifi"}
            </span>
            <SaveButton
              dirty
              valid
              saving={saving}
              saved={saved}
              onClick={() => void run(() => updateOperator(operator.id, { gateway_paused: !paused } as OperatorSettings), "Couldn't change that.")}
              label={paused ? "Resume payments through Printifi" : "Pause payments through Printifi"}
            />
          </div>
        </>
      )}
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </div>
  );
}
