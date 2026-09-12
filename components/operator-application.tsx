"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Check, Clock, Loader2, Send, Store, X } from "lucide-react";
import {
  applyForDesk,
  myApplication,
  withdrawApplication,
  type ApplicationDraft,
  type MyApplication,
} from "@/lib/operator";
import { useAuthKey } from "@/hooks/use-auth-key";
import { cn, easeIos, spring } from "@/lib/utils";

const FIELDS: {
  key: keyof ApplicationDraft;
  label: string;
  placeholder: string;
  required?: boolean;
  multiline?: boolean;
}[] = [
  { key: "display_name", label: "What should students see?", placeholder: "e.g. Sharma Xerox, Block C", required: true },
  { key: "campus", label: "Campus", placeholder: "e.g. Main campus", required: true },
  { key: "location", label: "Where exactly", placeholder: "e.g. Ground floor, next to the canteen" },
  { key: "phone", label: "Your phone", placeholder: "So Printify can reach you about this", required: true },
  { key: "machine", label: "Printer", placeholder: "e.g. HP LaserJet M428, duplex, mono" },
  { key: "note", label: "Anything else", placeholder: "Hours you can run, how many pages a day you can handle…", multiline: true },
];

const EMPTY: ApplicationDraft = { display_name: "", campus: "", location: "", phone: "", machine: "", note: "" };

/**
 * Asking to run a desk.
 *
 * Being an operator means taking other people's money and their documents,
 * so it isn't self-service: the admin reads the application, and accepting
 * it creates the desk and mints an owner code that only this account can
 * use. The admin hands the code over; it's entered in the box above this
 * panel. Nothing here ever shows the code — that's the admin's to give.
 */
export function OperatorApplication({ onChanged }: { onChanged?: () => void }) {
  const authKey = useAuthKey();
  const [existing, setExisting] = useState<MyApplication | null | "loading">("loading");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ApplicationDraft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setExisting(await myApplication());
    } catch (e) {
      setExisting(null);
      setError(e instanceof Error ? e.message : "Couldn't check your application.");
    }
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (existing === "loading") {
    return (
      <Shell>
        <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={15} className="animate-spin" />
          Checking your application…
        </p>
      </Shell>
    );
  }

  if (existing?.status === "pending") {
    return (
      <Shell tone="bone">
        <Title icon={<Clock size={16} strokeWidth={2.2} />}>Application received</Title>
        <p className="m-0 mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed opacity-80">
          Printify is reviewing <b className="font-semibold">{existing.display_name}</b>. When it&apos;s
          accepted, the admin sends you an owner code — enter it above and the desk is yours.
        </p>
        <dl className="m-0 mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11.5px]">
          <dt className="opacity-60">campus</dt>
          <dd className="m-0">{existing.campus}</dd>
          <dt className="opacity-60">sent</dt>
          <dd className="m-0">{new Date(existing.created_at).toLocaleString()}</dd>
        </dl>
        <button
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await withdrawApplication(existing.id);
              await load();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't withdraw it.");
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          className="mt-3.5 rounded-xl border border-line bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-soft disabled:opacity-50"
        >
          Withdraw
        </button>
        {error && <p className="m-0 mt-2 text-[12px] text-clay-ink">{error}</p>}
      </Shell>
    );
  }

  if (existing?.status === "approved") {
    return (
      <Shell tone="sage">
        <Title icon={<Check size={16} strokeWidth={2.6} />}>Accepted</Title>
        <p className="m-0 mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed opacity-80">
          <b className="font-semibold">{existing.display_name}</b> is set up and waiting for you.
          {existing.code_live
            ? " The admin has your owner code — it works only on this account. Enter it above."
            : " Your owner code has been used, cancelled or has expired; ask the admin for a fresh one and enter it above."}
        </p>
        {existing.review_note && (
          <p className="m-0 mt-2 text-[12px] opacity-80">From the admin: {existing.review_note}</p>
        )}
      </Shell>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await applyForDesk(draft);
      setDraft(EMPTY);
      setOpen(false);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  const missing = FIELDS.filter((f) => f.required && !draft[f.key].trim());

  return (
    <Shell>
      {existing?.status === "rejected" && (
        <div className="mb-3.5 rounded-[14px] bg-clay px-4 py-3 text-[12.5px] leading-relaxed text-clay-ink">
          <b className="font-semibold">Your last application wasn&apos;t accepted.</b>
          {existing.review_note ? ` ${existing.review_note}` : ""} You can apply again.
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Title icon={<Store size={16} strokeWidth={2.2} />}>Want to run a desk?</Title>
          <p className="m-0 mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-muted">
            Operators set their own prices, hours and queue. Applications are read by a person —
            you&apos;ll be handling other people&apos;s documents and money — and an accepted one comes
            back as an owner code for this account.
          </p>
        </div>
        {!open && (
          <button
            onClick={() => {
              setOpen(true);
              setError(null);
            }}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper"
          >
            Apply
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: easeIos }}
            className="overflow-hidden"
          >
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <label key={f.key} className={cn("flex flex-col gap-1.5", f.multiline && "sm:col-span-2")}>
                  <span className="text-[12.5px] font-semibold tracking-[-0.01em]">
                    {f.label}
                    {!f.required && <span className="ml-1.5 font-normal text-faint">optional</span>}
                  </span>
                  {f.multiline ? (
                    <textarea
                      rows={3}
                      value={draft[f.key]}
                      placeholder={f.placeholder}
                      maxLength={1000}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      className="resize-y rounded-xl border border-line bg-surface-sunk px-3 py-2.5 text-[13px] outline-none focus:border-ink"
                    />
                  ) : (
                    <input
                      value={draft[f.key]}
                      placeholder={f.placeholder}
                      maxLength={f.key === "phone" ? 32 : f.key === "location" || f.key === "machine" ? 200 : 120}
                      inputMode={f.key === "phone" ? "tel" : undefined}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      className="rounded-xl border border-line bg-surface-sunk px-3 py-2.5 text-[13px] outline-none focus:border-ink"
                    />
                  )}
                </label>
              ))}
            </div>

            {error && (
              <p className="m-0 mt-3.5 flex items-start gap-2 rounded-xl bg-clay px-3 py-2.5 text-[12px] leading-relaxed text-clay-ink">
                <AlertCircle size={14} strokeWidth={2.2} className="mt-px shrink-0" />
                {error}
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <motion.button
                whileTap={{ scale: missing.length ? 1 : 0.98 }}
                transition={spring}
                disabled={busy || missing.length > 0}
                onClick={submit}
                className={cn(
                  "flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[13px] font-semibold transition-colors",
                  missing.length ? "cursor-not-allowed border border-line text-faint" : "bg-ink text-paper",
                )}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} strokeWidth={2.2} />}
                {missing.length ? `Fill in ${missing[0].label.toLowerCase()}` : "Send application"}
              </motion.button>
              <button
                onClick={() => setOpen(false)}
                className="flex h-11 items-center gap-1.5 rounded-xl border border-line px-4 text-[13px] font-semibold text-muted"
              >
                <X size={14} strokeWidth={2.2} />
                Not now
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {!open && error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </Shell>
  );
}

function Shell({ children, tone }: { children: React.ReactNode; tone?: "bone" | "sage" }) {
  return (
    <div
      className={cn(
        "rounded-[20px] p-4 lg:p-5",
        tone === "sage"
          ? "bg-sage text-sage-ink"
          : tone === "bone"
            ? "bg-bone text-ink"
            : "border border-line bg-surface shadow-card",
      )}
    >
      {children}
    </div>
  );
}

function Title({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="m-0 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
      {icon}
      {children}
    </p>
  );
}
