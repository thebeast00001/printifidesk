"use client";

import { motion } from "motion/react";
import { nextRound } from "@/lib/delivery";
import type { PlatformSettings } from "@/lib/platform";
import { cn, spring } from "@/lib/utils";

/** Where a delivery goes: a spot on campus, and a line of detail. */
export interface SpotDraft {
  spot: string;
  detail: string;
}

/**
 * The spot and the detail, as the student fills them in — on the print
 * sheet when ordering, and from the status capsule when they've moved.
 *
 * The spots are the admin's list (a hostel, the library entrance, a gate,
 * the canteen); with no list, a free line. The detail is the room number
 * or "near the steps" — optional, because "Canteen" needs no more.
 */
export function SpotFields({
  settings,
  value,
  onChange,
  autoFocus,
}: {
  settings: PlatformSettings;
  value: SpotDraft;
  onChange: (next: SpotDraft) => void;
  autoFocus?: boolean;
}) {
  const areas = settings.delivery_areas;
  const listed = areas.length > 0;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="m-0 mb-2 text-[11.5px] font-semibold text-ink-soft">Spot</p>
        {listed ? (
          <div className="flex flex-wrap gap-[7px]">
            {areas.map((a) => (
              <motion.button
                key={a}
                type="button"
                whileTap={{ scale: 0.97 }}
                transition={spring}
                onClick={() => onChange({ ...value, spot: a })}
                aria-pressed={value.spot === a}
                className={cn(
                  "h-10 rounded-full border px-3.5 text-[12.5px] font-semibold transition-colors",
                  value.spot === a ? "border-ink bg-ink text-paper" : "border-line bg-surface text-ink-soft",
                )}
              >
                {a}
              </motion.button>
            ))}
          </div>
        ) : (
          <input
            value={value.spot}
            maxLength={60}
            autoFocus={autoFocus}
            onChange={(e) => onChange({ ...value, spot: e.target.value })}
            placeholder="e.g. Library entrance, Ganga hostel"
            className="h-11 w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[14px] outline-none placeholder:text-faint focus:border-ink"
          />
        )}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-semibold text-ink-soft">
          Where exactly <span className="font-normal text-faint">— room number, floor, a landmark</span>
        </span>
        <input
          value={value.detail}
          maxLength={60}
          onChange={(e) => onChange({ ...value, detail: e.target.value })}
          placeholder="e.g. Room 213, or near the steps"
          className="h-11 w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[14px] outline-none placeholder:text-faint focus:border-ink"
        />
      </label>
    </div>
  );
}

/** "The 1:00 pm round" / "the next round" — how the choice is framed. */
export function roundPhrase(settings: PlatformSettings, now: Date = new Date()): string {
  const next = nextRound(settings.delivery_rounds, settings.delivery_tz, now);
  return next ? `the ${next} round` : "the next round";
}

/** Whether a draft can be sent. The database checks it again. */
export function spotProblem(draft: SpotDraft | null): string | null {
  if (!draft) return null;
  if (!draft.spot.trim()) return "Where should it come to?";
  if (draft.detail.length > 60) return "Keep the detail short — a room number, or where exactly.";
  return null;
}
