"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, Power } from "lucide-react";
import { setOperatorOpen, type Operator } from "@/lib/orders";
import { nextChange, openState } from "@/lib/hours";
import { cn, spring } from "@/lib/utils";

const CLOSE_PRESETS = ["Back in 30 min", "Out of toner", "Closed for today"];

/**
 * The switch students see as "Open now" / "Closed".
 *
 * The desk's hours are the default; this is a person's decision that wins
 * until the hours next change (0041) — open early and you're open now, and
 * still closed by the hours this evening; close early and you're closed
 * now, and open again by the hours tomorrow. What's drawn here is what
 * students see: the hours' answer, or the switch's if it was flipped since
 * the hours last changed. Flipping it pushes over realtime, so every open
 * device changes immediately.
 */
export function OpenSwitch({
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

  // Shut by the admin: the database would refuse the flip with the reason;
  // the switch says so before anyone tries.
  const shut = operator.shut_at !== null;
  // What students see right now, and why; the button always offers the other.
  const state = openState(operator);
  const open = state.open;
  const next = nextChange(operator);

  if (compact) {
    return (
      <motion.button
        whileTap={{ scale: 0.96 }}
        transition={spring}
        disabled={busy || shut}
        title={shut ? `Closed by Printify: ${operator.shut_reason ?? ""}` : undefined}
        onClick={() => apply(!open, null)}
        className={cn(
          "flex h-11 items-center gap-2 rounded-xl px-4 text-[13px] font-semibold disabled:opacity-50",
          open ? "bg-sage text-sage-ink" : "bg-clay text-clay-ink",
        )}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} strokeWidth={2.2} />}
        {open ? "Open" : "Closed"}
      </motion.button>
    );
  }

  return (
    <div
      className={cn(
        "rounded-[20px] border p-4 lg:p-5",
        open ? "border-sage bg-sage/25" : "border-clay bg-clay/25",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="m-0 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
            <span
              className={cn(
                "inline-block size-2 rounded-full",
                open ? "bg-sage" : "bg-clay",
              )}
            />
            {open ? "Printify is open" : "Printify is closed"}
          </p>
          <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">
            {open
              ? state.by === "switch"
                ? `You opened it${next ? ` · closes by your hours ${next.replace(/^till /, "at ")}` : ""}. Students can place orders and see your live wait.`
                : `Open by your hours${next ? ` ${next}` : ""}. Students can place orders and see your live wait.`
              : state.by === "shut"
                ? "Closed by Printify."
                : state.by === "switch"
                  ? `You closed it${next ? ` · ${next} by your hours` : ""}. Students see Printify as closed.`
                  : `Closed by your hours${next ? ` · ${next}` : ""}. Tap Open to open early — your hours close it again as usual.`}
          </p>
        </div>

        <motion.button
          whileTap={{ scale: 0.96 }}
          transition={spring}
          disabled={busy}
          onClick={() => apply(!open, open ? note.trim() || null : null)}
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-xl px-4 py-3 text-[13px] font-semibold disabled:opacity-50",
            open ? "border border-line bg-surface text-ink" : "bg-ink text-paper",
          )}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} strokeWidth={2.2} />}
          {open ? "Close Printify" : "Open Printify"}
        </motion.button>
      </div>

      {!open && (
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
