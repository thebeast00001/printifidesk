"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, Power } from "lucide-react";
import { setOperatorOpen, type Operator } from "@/lib/orders";
import { cn, spring } from "@/lib/utils";

const CLOSE_PRESETS = ["Back in 30 min", "Out of toner", "Closed for today"];

/**
 * The switch students see as "Open now" / "Closed".
 *
 * It's a person's decision, not a clock's: a job can only be printed if
 * somebody is standing at the machine. Flipping it pushes over realtime, so
 * every open device changes immediately.
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
