"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { updateOperator, type Operator, type OperatorSettings } from "@/lib/orders";
import { isValidVpa } from "@/lib/upi";
import { money, quote, rateCardOf, DEFAULT_CONFIG } from "@/lib/pricing";
import { cn, spring } from "@/lib/utils";

type Field = {
  key: keyof OperatorSettings;
  label: string;
  hint: string;
  /** Shown after the input: a currency, a unit, or a percent sign. */
  suffix?: "currency" | "%" | "pages" | "min" | "gsm";
  step?: number;
  min?: number;
  max?: number;
  /** Stored 0–1 but edited as a whole percentage. */
  percent?: boolean;
};

const GROUPS: { title: string; note?: string; fields: Field[] }[] = [
  {
    title: "Per page",
    note: "What a single side costs. Everything else is built from these two.",
    fields: [
      { key: "bw_per_page", label: "Black & white", hint: "per printed side", suffix: "currency", step: 0.25, min: 0 },
      { key: "colour_per_page", label: "Colour", hint: "per printed side", suffix: "currency", step: 0.5, min: 0 },
    ],
  },
  {
    title: "Discounts",
    note: "Both are optional. Set either to 0 to turn it off.",
    fields: [
      {
        key: "duplex_discount",
        label: "Both sides",
        hint: "taken off when a job prints duplex",
        suffix: "%",
        percent: true,
        step: 1,
        min: 0,
        max: 90,
      },
      {
        key: "bulk_threshold",
        label: "Bulk from",
        hint: "pages in one job before the bulk rate applies",
        suffix: "pages",
        step: 10,
        min: 1,
      },
      {
        key: "bulk_multiplier",
        label: "Bulk rate",
        hint: "share of the normal paper price at that size",
        suffix: "%",
        percent: true,
        step: 1,
        min: 1,
        max: 100,
      },
    ],
  },
  {
    title: "Extras",
    fields: [
      { key: "staple_price", label: "Staple", hint: "flat, per copy", suffix: "currency", step: 1, min: 0 },
      { key: "min_order", label: "Minimum job", hint: "smallest amount worth running", suffix: "currency", step: 5, min: 0 },
      { key: "paper_gsm", label: "Paper", hint: "shown to students", suffix: "gsm", step: 10, min: 40 },
    ],
  },
  {
    title: "Stock",
    note: "Leave blank to not track it. At zero, Printify closes itself rather than taking orders you can't fulfil.",
    fields: [
      { key: "paper_stock", label: "Sheets left", hint: "counted down as jobs are collected", suffix: "pages", step: 100, min: 0 },
      { key: "low_paper_at", label: "Warn at", hint: "sheets remaining", suffix: "pages", step: 50, min: 0 },
      { key: "toner_pages", label: "Toner pages left", hint: "estimate from the cartridge", suffix: "pages", step: 100, min: 0 },
      { key: "low_toner_at", label: "Warn at", hint: "pages remaining", suffix: "pages", step: 50, min: 0 },
    ],
  },
  {
    title: "Speed",
    note: "Used for the wait estimate students see. Set it to what the machine really does.",
    fields: [
      { key: "pages_per_minute", label: "Pages a minute", hint: "measured, not the box's claim", suffix: "pages", step: 1, min: 1 },
      { key: "handling_minutes", label: "Handling", hint: "fetching, stapling, handover", suffix: "min", step: 1, min: 0 },
    ],
  },
];

const toEditable = (f: Field, v: unknown) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : (v as number);
  if (!Number.isFinite(n)) return "";
  return String(f.percent ? Math.round(n * 100) : n);
};

/**
 * The operator's rate card.
 *
 * Prices are theirs to set — paper, toner and competition differ desk to desk —
 * so nothing here is a constant in the app. Changes are previewed against a
 * real example job before they're saved, because a rate card is easy to get
 * wrong by a decimal place.
 */
export function OperatorPricing({
  operator,
  onSaved,
}: {
  operator: Operator;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useMemo(() => {
    const next: Record<string, string> = {};
    for (const g of GROUPS) {
      for (const f of g.fields) next[f.key] = toEditable(f, operator[f.key as keyof Operator]);
    }
    return next;
  }, [operator]);

  useEffect(() => setDraft(reset), [reset]);

  const dirty = Object.keys(reset).some((k) => reset[k] !== draft[k]);

  /* Preview against a job the operator will recognise, priced with the values
     currently in the boxes rather than the ones already saved. */
  const preview = useMemo(() => {
    const patched: Record<string, number> = {};
    for (const g of GROUPS) {
      for (const f of g.fields) {
        const n = Number.parseFloat(draft[f.key] ?? "");
        if (Number.isFinite(n)) patched[f.key] = f.percent ? n / 100 : n;
      }
    }
    const card = rateCardOf({ ...operator, ...patched });
    return {
      card,
      small: quote(10, 0, { ...DEFAULT_CONFIG, binding: "staple" }, card),
      big: quote(120, 4, DEFAULT_CONFIG, card),
    };
  }, [draft, operator]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, number> = {};
      for (const g of GROUPS) {
        for (const f of g.fields) {
          const n = Number.parseFloat(draft[f.key] ?? "");
          if (!Number.isFinite(n)) continue;
          patch[f.key] = f.percent ? n / 100 : n;
        }
      }
      await updateOperator(operator.id, patch as OperatorSettings);
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save those rates.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading m-0 text-[18px] font-bold">Your prices</h2>
          <p className="m-0 mt-1 text-[12.5px] text-muted">
            Students see these instantly. Nothing is hardcoded in the app.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={() => setDraft(reset)}
              className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-2.5 text-[12.5px] font-semibold text-muted transition-colors hover:bg-surface-sunk"
            >
              <RotateCcw size={13} strokeWidth={2.2} />
              Undo
            </button>
          )}
          <motion.button
            whileTap={{ scale: dirty ? 0.96 : 1 }}
            transition={spring}
            disabled={!dirty || saving}
            onClick={save}
            className={cn(
              "flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-colors",
              dirty ? "bg-ink text-paper" : "border border-line text-faint",
            )}
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : saved ? (
              <Check size={14} strokeWidth={2.6} />
            ) : null}
            {saving ? "Saving…" : saved ? "Saved" : dirty ? "Save prices" : "No changes"}
          </motion.button>
        </div>
      </div>

      {error && (
        <p className="m-0 mb-3.5 rounded-xl bg-clay px-3 py-2.5 text-[12px] leading-relaxed text-clay-ink">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-5">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <p className="label-caps m-0 mb-2">{group.title}</p>
            {group.note && (
              <p className="m-0 mb-2.5 text-[11.5px] leading-relaxed text-muted">{group.note}</p>
            )}
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {group.fields.map((f) => (
                <label
                  key={f.key}
                  className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface-sunk p-3"
                >
                  <span className="text-[12.5px] font-semibold tracking-[-0.01em]">{f.label}</span>
                  <span className="flex items-center gap-1.5">
                    {f.suffix === "currency" && (
                      <span className="font-mono text-[13px] text-muted">
                        {operator.currency ?? "₹"}
                      </span>
                    )}
                    <input
                      type="number"
                      inputMode="decimal"
                      step={f.step ?? 1}
                      min={f.min}
                      max={f.max}
                      value={draft[f.key] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      className="w-full min-w-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-ink"
                    />
                    {f.suffix && f.suffix !== "currency" && (
                      <span className="font-mono text-[11.5px] whitespace-nowrap text-muted">
                        {f.suffix}
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] leading-snug text-muted">{f.hint}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <HoursSettings operator={operator} onSaved={onSaved} />

      <UpiSettings operator={operator} onSaved={onSaved} />

      {/* Two real quotes, so a mistyped decimal is obvious before saving. */}
      <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
        <PreviewCard
          title="10 pages, stapled"
          detail="black & white, both sides"
          amount={money(preview.small.total, preview.card.currency)}
        />
        <PreviewCard
          title="120 pages, 4 in colour"
          detail="smart colour, both sides, loose"
          amount={money(preview.big.total, preview.card.currency)}
        />
      </div>
    </section>
  );
}

function PreviewCard({
  title,
  detail,
  amount,
}: {
  title: string;
  detail: string;
  amount: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[14px] bg-bone px-4 py-3 text-ink">
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold tracking-[-0.01em]">{title}</span>
        <span className="mt-0.5 block text-[11px] opacity-70">{detail}</span>
      </span>
      <span className="font-figure shrink-0 text-[22px] font-extrabold">{amount}</span>
    </div>
  );
}

/**
 * Where the money goes.
 *
 * Students pay this id directly — Printify never touches the funds, which is
 * both simpler and keeps us out of holding anyone's money. A malformed id
 * fails silently inside the payer's UPI app, so it's validated before saving.
 */
function UpiSettings({ operator, onSaved }: { operator: Operator; onSaved: () => void }) {
  const [vpa, setVpa] = useState(operator.upi_vpa ?? "");
  const [name, setName] = useState(operator.upi_name ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVpa(operator.upi_vpa ?? "");
    setName(operator.upi_name ?? "");
  }, [operator.upi_vpa, operator.upi_name]);

  const trimmed = vpa.trim();
  const looksValid = trimmed === "" || isValidVpa(trimmed);
  const dirty = trimmed !== (operator.upi_vpa ?? "") || name.trim() !== (operator.upi_name ?? "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateOperator(operator.id, {
        upi_vpa: trimmed || null,
        upi_name: name.trim() || null,
      } as OperatorSettings);
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-5">
      <p className="label-caps m-0 mb-2">Getting paid</p>
      <p className="m-0 mb-3 max-w-[60ch] text-[11.5px] leading-relaxed text-muted">
        Students get a UPI link with the amount and the order token already filled in, and pay you
        directly. Leave it blank to take cash only.
      </p>

      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface-sunk p-3">
          <span className="text-[12.5px] font-semibold tracking-[-0.01em]">Your UPI id</span>
          <input
            value={vpa}
            onChange={(e) => setVpa(e.target.value)}
            placeholder="name@bank"
            className={cn(
              "w-full min-w-0 rounded-lg border bg-surface px-2.5 py-1.5 font-mono text-[13px] outline-none",
              looksValid ? "border-line focus:border-ink" : "border-clay",
            )}
          />
          <span className={cn("text-[11px] leading-snug", looksValid ? "text-muted" : "text-clay-ink dark:text-clay")}>
            {looksValid ? "Exactly as it appears in your UPI app" : "That doesn't look like a UPI id"}
          </span>
        </label>

        <label className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface-sunk p-3">
          <span className="text-[12.5px] font-semibold tracking-[-0.01em]">Name to show</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={operator.short_name || operator.name}
            className="w-full min-w-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-ink"
          />
          <span className="text-[11px] leading-snug text-muted">
            What the student sees while paying
          </span>
        </label>
      </div>

      <motion.button
        whileTap={{ scale: dirty && looksValid ? 0.96 : 1 }}
        transition={spring}
        disabled={!dirty || !looksValid || saving}
        onClick={save}
        className={cn(
          "mt-3 flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-colors",
          dirty && looksValid ? "bg-ink text-paper" : "border border-line text-faint",
        )}
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} strokeWidth={2.6} /> : null}
        {saving ? "Saving…" : saved ? "Saved" : "Save UPI id"}
      </motion.button>

      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </div>
  );
}

/**
 * Advertised opening hours.
 *
 * These no longer decide whether Printify is open — the switch does — but they
 * generate the pickup slots a student can book, so an evening desk offering
 * 9-to-5 slots is a real problem.
 */
function HoursSettings({ operator, onSaved }: { operator: Operator; onSaved: () => void }) {
  const trim = (t: string | null | undefined) => (t ?? "").slice(0, 5);
  const [opens, setOpens] = useState(trim(operator.opens_at));
  const [closes, setCloses] = useState(trim(operator.closes_at));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpens(trim(operator.opens_at));
    setCloses(trim(operator.closes_at));
  }, [operator.opens_at, operator.closes_at]);

  const ordered = opens < closes;
  const dirty = opens !== trim(operator.opens_at) || closes !== trim(operator.closes_at);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateOperator(operator.id, {
        opens_at: `${opens}:00`,
        closes_at: `${closes}:00`,
      } as OperatorSettings);
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save those hours.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-5">
      <p className="label-caps m-0 mb-2">Hours</p>
      <p className="m-0 mb-3 max-w-[60ch] text-[11.5px] leading-relaxed text-muted">
        Used to generate the pickup times students can book. Opening and closing is still the
        switch, not the clock.
      </p>

      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold tracking-[-0.01em]">Opens</span>
          <input
            type="time"
            value={opens}
            onChange={(e) => setOpens(e.target.value)}
            className="rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-ink"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold tracking-[-0.01em]">Closes</span>
          <input
            type="time"
            value={closes}
            onChange={(e) => setCloses(e.target.value)}
            className={cn(
              "rounded-lg border bg-surface-sunk px-2.5 py-1.5 font-mono text-[13px] outline-none",
              ordered ? "border-line focus:border-ink" : "border-clay",
            )}
          />
        </label>

        <motion.button
          whileTap={{ scale: dirty && ordered ? 0.96 : 1 }}
          transition={spring}
          disabled={!dirty || !ordered || saving}
          onClick={save}
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-colors",
            dirty && ordered ? "bg-ink text-paper" : "border border-line text-faint",
          )}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} strokeWidth={2.6} /> : null}
          {saving ? "Saving…" : saved ? "Saved" : "Save hours"}
        </motion.button>
      </div>

      {!ordered && (
        <p className="m-0 mt-2 text-[11.5px] text-clay-ink dark:text-clay">
          Closing time has to be after opening time. Overnight hours aren&apos;t supported yet.
        </p>
      )}
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </div>
  );
}
