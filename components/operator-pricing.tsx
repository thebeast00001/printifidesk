"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Camera, Check, Loader2, RotateCcw } from "lucide-react";
import { updateOperator, type Operator, type OperatorSettings } from "@/lib/orders";
import { isQrOnlyMerchant, normaliseVpa, parseUpiQr, vpaProblem, type UpiKind } from "@/lib/upi";
import { decodePixels } from "./operator/scan-sheet";
import { money, quote, rateCardOf, DEFAULT_CONFIG } from "@/lib/pricing";
import { cn, spring } from "@/lib/utils";
import { ExtrasSettings, WeeklyHoursSettings, WindowsSettings } from "./operator/desk-setup";

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

      <ExtrasSettings operator={operator} onSaved={onSaved} />

      <WeeklyHoursSettings operator={operator} onSaved={onSaved} />

      <WindowsSettings operator={operator} onSaved={onSaved} />

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
  const [kind, setKind] = useState<UpiKind>(operator.upi_kind ?? "personal");
  const [mc, setMc] = useState<string | null>(operator.upi_mc ?? null);
  // The standee's QR text, verbatim, when the id came from a photo. Cleared
  // if the id is then typed over — a QR for a different id would be a lie.
  const [qrText, setQrText] = useState<string | null>(operator.upi_qr ?? null);
  const [read, setRead] = useState<string | null>(null);
  const [round, setRound] = useState(operator.round_to_rupee === true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVpa(operator.upi_vpa ?? "");
    setName(operator.upi_name ?? "");
    setKind(operator.upi_kind ?? "personal");
    setMc(operator.upi_mc ?? null);
    setQrText(operator.upi_qr ?? null);
    setRound(operator.round_to_rupee === true);
  }, [operator.upi_vpa, operator.upi_name, operator.upi_kind, operator.upi_mc, operator.round_to_rupee]);

  // A paste from WhatsApp or a business app brings invisible characters,
  // and some phones copy a QR's whole upi:// text — both become the id.
  const trimmed = normaliseVpa(vpa);
  const problem = vpaProblem(vpa);
  const looksValid = problem === null;
  const dirty =
    trimmed !== (operator.upi_vpa ?? "") ||
    name.trim() !== (operator.upi_name ?? "") ||
    kind !== (operator.upi_kind ?? "personal") ||
    (mc ?? null) !== (operator.upi_mc ?? null) ||
    (qrText ?? null) !== (operator.upi_qr ?? null) ||
    round !== (operator.round_to_rupee === true);
  const qrOnly = isQrOnlyMerchant(trimmed, kind);

  // A photo of the shop's own QR standee: the id, the name and — the part
  // that matters — whether it's a merchant id, read off the code itself.
  async function readPhoto(file: File) {
    setError(null);
    setRead(null);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Couldn't open that photo."));
        img.src = url;
      });
      const text = decodePixels(img, document.createElement("canvas"));
      const found = text ? parseUpiQr(text) : null;
      if (!found) {
        setError(text ? "That QR isn't a UPI one." : "No QR code found in that photo — get closer, in good light.");
        return;
      }
      setVpa(found.vpa);
      if (found.name && !name.trim()) setName(found.name);
      setKind(found.kind);
      setMc(found.merchantCode);
      setQrText(found.kind === "merchant" && text ? text.slice(0, 2000) : null);
      setRead(`${found.vpa} · ${found.kind === "merchant" ? `merchant, code ${found.merchantCode}` : "personal id"}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateOperator(operator.id, {
        upi_vpa: trimmed || null,
        upi_name: name.trim() || null,
        upi_kind: kind,
        upi_mc: kind === "merchant" ? mc : null,
        // The QR belongs to the id it was read with; a typed-over id drops it.
        upi_qr: kind === "merchant" && qrText && qrText.includes(trimmed) ? qrText : null,
        round_to_rupee: round,
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
        Students pay this id directly. Leave it blank to take cash only.
        {operator.gateway_status === "active" ? (
          <span className="mt-1 block text-sage-ink">
            Online payments through Printify are on: students can also pay by any UPI app or card with the
            amount filled in; those arrive already confirmed, your share settles to your account daily, and
            the Printify fee on them is taken at source.
          </span>
        ) : operator.gateway_status === "collect" ? (
          <span className="mt-1 block text-sage-ink">
            Online payments through Printify are on: students can also pay by card or any UPI app with the amount
            filled in. Those land with Printify; your share is paid out to you and shown under Takings.
          </span>
        ) : operator.gateway_status === "pending" ? (
          <span className="mt-1 block">Online payments through Printify: Cashfree is still verifying your settlement account.</span>
        ) : null}
      </p>

      <div className="mb-2.5 grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="grid grid-cols-2 gap-1 rounded-[14px] border border-line bg-surface-sunk p-1">
          {(
            [
              ["merchant", "Business QR id", "Amount arrives pre-filled"],
              ["personal", "Personal id", "Students type the amount"],
            ] as const
          ).map(([k, label, hint]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "flex flex-col items-start rounded-[11px] px-3 py-2 text-left transition-colors",
                kind === k ? "bg-surface shadow-card" : "text-muted hover:bg-surface/60",
              )}
            >
              <span className="text-[12.5px] font-semibold tracking-[-0.01em]">{label}</span>
              <span className="text-[10.5px] leading-snug opacity-75">{hint}</span>
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-[14px] border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink-soft hover:bg-surface-sunk">
          <Camera size={14} strokeWidth={2.2} />
          Read from a photo of your QR
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void readPhoto(f);
            }}
          />
        </label>
      </div>
      <p className="m-0 mb-3 max-w-[64ch] text-[11px] leading-relaxed text-muted">
        {kind === "merchant" ? (
          <>
            The id behind your PhonePe Business, Paytm for Business or GPay Business QR — the one on
            the standee. Students get a one-tap link with the amount filled in for Google Pay, Paytm and
            most apps; PhonePe refuses links from any website, so there they copy the id and type the
            amount, same as for a personal id.
            {mc && <> Your QR&apos;s merchant code is <span className="font-mono">{mc}</span>.</>}
          </>
        ) : (
          <>
            An ordinary <span className="font-mono">name@bank</span> id. UPI apps refuse a link with the
            amount pre-filled to a personal id — &quot;transaction not allowed&quot; — so students copy the
            id and type the amount. A free business QR from PhonePe or Paytm fixes that.
          </>
        )}
        {read && <span className="block text-sage-ink"> Read from the photo: {read}</span>}
        {qrOnly && (
          <span className="mt-1.5 block text-clay-ink dark:text-clay">
            A Paytm merchant id takes money only through its own QR — other apps refuse a link with the
            amount and refuse the id typed in. {qrText && qrText.includes(trimmed)
              ? "Your standee's QR is saved with it, so students scan that; on their own phone they open the saved image from the app's gallery."
              : "Read your standee from a photo so students can scan the real QR — or use your PhonePe Business / GPay Business id, or a personal id, which every app can pay by typing."}
          </span>
        )}
      </p>

      {/* Whole rupees: what a student types is "14", not "13.91". Any kind of
          id can have it; a personal one nearly always should. */}
      <label className="mb-3 flex cursor-pointer items-start gap-3 rounded-[14px] border border-line bg-surface-sunk p-3">
        <input
          type="checkbox"
          checked={round}
          onChange={(e) => setRound(e.target.checked)}
          className="mt-0.5 size-4 accent-ink"
        />
        <span className="min-w-0">
          <span className="block text-[12.5px] font-semibold tracking-[-0.01em]">Round every bill up to the rupee</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted">
            ₹13.91 becomes ₹14, shown on the bill as its own line. Fewer wrong amounts when the
            student types it; the paise are yours.
            {kind === "personal" && !round && " Recommended with a personal id."}
          </span>
        </span>
      </label>

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
            {problem ?? (trimmed && trimmed !== vpa ? `Will be saved as ${trimmed}` : "Exactly as it appears in your UPI app")}
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

