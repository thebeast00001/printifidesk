"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Check, Clock, Loader2, Send, X } from "lucide-react";
import {
  myApplication,
  submitApplication,
  withdrawApplication,
  type Application,
  type ApplicationDraft,
} from "@/lib/operator";
import { useAuthKey } from "@/hooks/use-auth-key";
import { cn, spring } from "@/lib/utils";

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
  { key: "phone", label: "Your phone", placeholder: "So we can reach you about this", required: true },
  { key: "machine", label: "Printer", placeholder: "e.g. HP LaserJet M428, duplex, mono" },
  { key: "note", label: "Anything else", placeholder: "Hours you can run, how many pages a day you can handle…", multiline: true },
];

const EMPTY: ApplicationDraft = {
  display_name: "",
  campus: "",
  location: "",
  phone: "",
  machine: "",
  note: "",
};

/**
 * Applying to run a desk.
 *
 * Being an operator means taking other people's money and their documents, so
 * it isn't self-service: an application is reviewed by an admin, and only
 * approval creates the operator and the staff row (both in one transaction).
 */
export function OperatorApplication() {
  const authKey = useAuthKey();
  const [existing, setExisting] = useState<Application | null | "loading">("loading");
  const [draft, setDraft] = useState<ApplicationDraft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setExisting(await myApplication());
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (existing === "loading") {
    return (
      <Panel>
        <Loader2 size={15} className="animate-spin" />
        Checking your application…
      </Panel>
    );
  }

  if (existing?.status === "pending") {
    return (
      <Card
        tone="bone"
        icon={<Clock size={17} strokeWidth={2.2} />}
        title="Application received"
        body={`We're reviewing “${existing.display_name}”. You'll get access here as soon as it's approved.`}
      >
        <dl className="m-0 mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11.5px]">
          <dt className="text-muted">campus</dt>
          <dd className="m-0">{existing.campus}</dd>
          <dt className="text-muted">sent</dt>
          <dd className="m-0">{new Date(existing.created_at).toLocaleString()}</dd>
        </dl>
        <button
          onClick={async () => {
            setBusy(true);
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
        {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
      </Card>
    );
  }

  if (existing?.status === "approved") {
    return (
      <Card
        tone="sage"
        icon={<Check size={17} strokeWidth={2.4} />}
        title="Approved"
        body="Your operator is set up. Reload this page to open your portal."
      />
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await submitApplication(draft);
      setDraft(EMPTY);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  const missing = FIELDS.filter((f) => f.required && !draft[f.key].trim());

  return (
    <div className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-6">
      {existing?.status === "rejected" && (
        <div className="mb-4 rounded-[14px] bg-clay px-4 py-3 text-[12.5px] leading-relaxed text-clay-ink">
          <b className="font-semibold">Your last application wasn&apos;t approved.</b>
          {existing.review_note ? ` ${existing.review_note}` : ""} You can apply again below.
        </div>
      )}

      <h2 className="font-heading m-0 text-[20px] font-bold">Run a Printify desk</h2>
      <p className="m-0 mt-1.5 mb-4 max-w-[60ch] text-[13px] leading-relaxed text-muted">
        Operators set their own prices, hours and queue. Applications are reviewed by hand — you&apos;ll
        be handling other people&apos;s documents and taking their money, so we check who you are first.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
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
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                className="resize-y rounded-xl border border-line bg-surface-sunk px-3 py-2.5 text-[13px] outline-none focus:border-ink"
              />
            ) : (
              <input
                value={draft[f.key]}
                placeholder={f.placeholder}
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

      <motion.button
        whileTap={{ scale: missing.length ? 1 : 0.98 }}
        transition={spring}
        disabled={busy || missing.length > 0}
        onClick={submit}
        className={cn(
          "mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[14px] font-semibold transition-colors sm:w-auto sm:px-6",
          missing.length ? "cursor-not-allowed border border-line text-faint" : "bg-ink text-paper",
        )}
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} strokeWidth={2.2} />}
        {missing.length ? `Fill in ${missing[0].label.toLowerCase()}` : "Send application"}
      </motion.button>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[20px] border border-line bg-surface p-4 text-[13px] text-muted lg:p-5">
      {children}
    </div>
  );
}

function Card({
  tone,
  icon,
  title,
  body,
  children,
}: {
  tone: "bone" | "sage";
  icon: React.ReactNode;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-[20px] p-4 lg:p-5",
        tone === "sage" ? "bg-sage text-sage-ink" : "bg-bone text-ink",
      )}
    >
      <p className="m-0 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
        {icon}
        {title}
      </p>
      <p className="m-0 mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed opacity-80">{body}</p>
      {children}
    </div>
  );
}

export { X };
