"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Loader2, Power, SlidersHorizontal } from "lucide-react";
import { useOperatorQueue } from "@/hooks/use-tracking";
import { setOperatorOpen, type Operator } from "@/lib/orders";
import { SignedOutNotice } from "./signed-out-notice";
import { useConnectionVerdict } from "./connection-banner";
import { JoinDesk } from "./join-desk";
import { OperatorPortal } from "./operator-portal";
import { OperatorPricing } from "./operator-pricing";
import { OperatorDay } from "./operator-day";
import { CloseoutPanel } from "./operator/closeout";
import { StaffPanel } from "./operator/staff-panel";
import { StockPanel } from "./operator/stock-panel";
import { useAuth, useClerk } from "@clerk/nextjs";
import { DeskSignIn } from "./operator/desk-sign-in";
import { DevicePanel } from "./operator/device-panel";
import { isPairedDevice } from "@/lib/desk-auth";
import { listStaff } from "@/lib/desk";
import { UserRoundCheck } from "lucide-react";
import { useApp } from "@/lib/store";
import { cn, spring } from "@/lib/utils";

/**
 * Routes between the three states someone can be in on this page: not signed
 * in, signed in but not an operator, or running one.
 */
export function OperatorBoard() {
  const { backend, operatorId, operator, reload } = useOperatorQueue();
  const { verdict } = useConnectionVerdict();
  const { userId } = useAuth();
  const clerk = useClerk();
  const view = useApp((s) => s.operatorView);
  // Read after mount: localStorage isn't there on the server, and a value
  // that differs between the two renders is a hydration mismatch.
  const [paired, setPaired] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  useEffect(() => setPaired(isPairedDevice()), []);
  useEffect(() => {
    if (!operatorId || !userId) return;
    void listStaff(operatorId).then((rows) =>
      setHasPin(rows.some((r) => r.user_id === userId && r.has_pin)),
    );
  }, [operatorId, userId, view]);
  const setView = useApp((s) => s.setOperatorView);
  const setPending = useApp((s) => s.setOperatorPending);
  const showSettings = view === "settings";

  // Leaving the page resets both, so coming back always lands on the queue
  // and the student-side dock never shows a stale operator badge.
  useEffect(() => {
    return () => {
      setView("queue");
      setPending(null);
    };
  }, [setView, setPending]);

  if (backend.state === "loading") {
    return <Notice icon={<Loader2 size={16} className="animate-spin" />} title="Opening…" />;
  }

  if (backend.state === "signed-out") {
    // A paired desk: the shift starts with a name and a PIN. Anything else:
    // the ordinary sign-in.
    if (paired) return <DeskSignIn />;
    return (
      <SignedOutNotice
        title="Sign in to continue"
        body="Operators sign in with the same account students use."
      />
    );
  }

  if (backend.state === "unconfigured") {
    return <Notice tone="clay" title="No backend configured" body={backend.message} />;
  }

  if (backend.state === "error") {
    return <Notice tone="clay" title="Can't reach the database" body={backend.message} />;
  }

  // Not staff anywhere. That's the normal case for almost everybody, so it
  // gets the join-code box rather than an error: the only way onto a desk is
  // a code from whoever runs it.
  if (!operatorId || !operator) {
    // A rejected token also produces "no operator"; the banner above already
    // explains that, so don't ask for a code on top of it.
    if (verdict.kind === "blocked") return null;
    if (verdict.kind === "checking") {
      return <Notice icon={<Loader2 size={16} className="animate-spin" />} title="Checking access…" />;
    }
    return <JoinDesk onJoined={() => void reload()} />;
  }

  return (
    <div className="flex flex-col gap-4" data-anim="board">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading m-0 text-[20px] font-bold">
            {operator.short_name || operator.name}
          </h2>
          <p className="m-0 mt-0.5 text-[12.5px] text-muted">{operator.campus}</p>
        </div>

        <div className="flex items-center gap-2">
          {paired && (
            <button
              onClick={() => void clerk.signOut({ redirectUrl: "/operator" })}
              title="End your shift — the next person taps their name"
              className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-surface-sunk"
            >
              <UserRoundCheck size={14} strokeWidth={2.2} />
              <span className="hidden sm:inline">Switch staff</span>
            </button>
          )}
          <OpenSwitch operator={operator} onChanged={reload} compact />
          <button
            onClick={() => setView(showSettings ? "queue" : "settings")}
            aria-expanded={showSettings}
            className={cn(
              "flex h-11 items-center gap-2 rounded-xl border px-4 text-[13px] font-semibold transition-colors",
              showSettings
                ? "border-ink bg-ink text-paper"
                : "border-line bg-surface text-ink-soft hover:bg-surface-sunk",
            )}
          >
            <SlidersHorizontal size={14} strokeWidth={2.2} />
            Settings
          </button>
        </div>
      </div>

      {view === "settings" ? (
        <div className="flex flex-col gap-4">
          <OpenSwitch operator={operator} onChanged={reload} />
          <OperatorPricing operator={operator} onSaved={reload} />
          <StockPanel operator={operator} onChanged={reload} />
          <StaffPanel operator={operator} me={userId ?? null} />
          <DevicePanel operator={operator} hasPin={hasPin} />
        </div>
      ) : view === "takings" ? (
        <div className="flex flex-col gap-4">
          <OperatorDay operator={operator} />
          <CloseoutPanel operator={operator} onClosed={reload} />
        </div>
      ) : (
        <OperatorPortal operator={operator} />
      )}
    </div>
  );
}

/* ---------- open / closed ---------- */

const CLOSE_PRESETS = ["Back in 30 min", "Out of toner", "Closed for today"];

/**
 * The switch students see as "Printify open" / "Printify closed".
 *
 * It's a person's decision, not a clock's: a job can only be printed if
 * somebody is standing at the machine. Flipping it pushes over realtime, so
 * every open device changes immediately.
 */
function OpenSwitch({
  operator,
  onChanged,
  compact,
}: {
  operator: Operator;
  onChanged: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(operator.status_note ?? "");
  const [error, setError] = useState<string | null>(null);

  async function apply(isOpen: boolean, statusNote: string | null) {
    setBusy(true);
    setError(null);
    try {
      await setOperatorOpen(operator.id, isOpen, statusNote);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the status.");
    } finally {
      setBusy(false);
    }
  }

  if (compact) {
    return (
      <motion.button
        whileTap={{ scale: 0.96 }}
        transition={spring}
        disabled={busy}
        onClick={() => apply(!operator.is_open, null)}
        className={cn(
          "flex h-11 items-center gap-2 rounded-xl px-4 text-[13px] font-semibold disabled:opacity-50",
          operator.is_open ? "bg-sage text-sage-ink" : "bg-clay text-clay-ink",
        )}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} strokeWidth={2.2} />}
        {operator.is_open ? "Open" : "Closed"}
      </motion.button>
    );
  }

  return (
    <div
      className={cn(
        "rounded-[20px] border p-4 lg:p-5",
        operator.is_open ? "border-sage bg-sage/25" : "border-clay bg-clay/25",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="m-0 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
            <span
              className={cn(
                "inline-block size-2 rounded-full",
                operator.is_open ? "bg-sage" : "bg-clay",
              )}
            />
            {operator.is_open ? "Printify is open" : "Printify is closed"}
          </p>
          <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">
            {operator.is_open
              ? "Students can place orders and see your live wait."
              : "Students see Printify as closed and can't place orders."}
          </p>
        </div>

        <motion.button
          whileTap={{ scale: 0.96 }}
          transition={spring}
          disabled={busy}
          onClick={() => apply(!operator.is_open, operator.is_open ? note.trim() || null : null)}
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-xl px-4 py-3 text-[13px] font-semibold disabled:opacity-50",
            operator.is_open ? "border border-line bg-surface text-ink" : "bg-ink text-paper",
          )}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} strokeWidth={2.2} />}
          {operator.is_open ? "Close Printify" : "Open Printify"}
        </motion.button>
      </div>

      {!operator.is_open && (
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() =>
              note.trim() !== (operator.status_note ?? "") && apply(false, note.trim() || null)
            }
            placeholder="Why, or when you're back — shown to students"
            maxLength={60}
            className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] outline-none focus:border-ink"
          />
          {CLOSE_PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => {
                setNote(preset);
                void apply(false, preset);
              }}
              className="rounded-full border border-line bg-surface px-3 py-2 text-[12px] font-semibold text-ink-soft transition-colors hover:bg-surface-sunk"
            >
              {preset}
            </button>
          ))}
        </div>
      )}

      {error && <p className="m-0 mt-2.5 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </div>
  );
}

function Notice({
  icon,
  title,
  body,
  tone,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  tone?: "clay";
}) {
  return (
    <div
      className={cn(
        "rounded-[18px] border p-4 lg:p-5",
        tone === "clay" ? "border-clay bg-clay/25" : "border-line bg-surface",
      )}
    >
      <p className="m-0 flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em]">
        {icon ?? (tone === "clay" ? <AlertCircle size={16} strokeWidth={2.2} /> : null)}
        {title}
      </p>
      {body && <p className="m-0 mt-1.5 text-[12.5px] leading-relaxed text-muted">{body}</p>}
    </div>
  );
}
