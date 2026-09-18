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
 * The spot is the student's words: a text line, with the admin's list
 * (a hostel, the library entrance, a gate, the canteen) as quick picks
 * that fill it. Both lines may be left blank when ordering — the runner
 * then calls the phone — because a student in a lecture block owes no one
 * a hostel name.
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
  const picks = settings.delivery_areas;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="m-0 mb-2 text-[11.5px] font-semibold text-ink-soft">
          Spot <span className="font-normal text-faint">— a hostel, a block, the library, the canteen</span>
        </p>
        {picks.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-[7px]">
            {picks.map((a) => (
              <motion.button
                key={a}
                type="button"
                whileTap={{ scale: 0.97 }}
                transition={spring}
                onClick={() => onChange({ ...value, spot: value.spot === a ? "" : a })}
                aria-pressed={value.spot === a}
                className={cn(
                  "h-9 rounded-full border px-3 text-[12px] font-semibold transition-colors",
                  value.spot === a ? "border-ink bg-ink text-paper" : "border-line bg-surface text-ink-soft",
                )}
              >
                {a}
              </motion.button>
            ))}
          </div>
        )}
        <input
          value={value.spot}
          maxLength={60}
          autoFocus={autoFocus}
          onChange={(e) => onChange({ ...value, spot: e.target.value })}
          placeholder={picks.length > 0 ? "Or type any spot on campus" : "e.g. Block C, Library entrance, Ganga hostel"}
          className="h-11 w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[14px] outline-none placeholder:text-faint focus:border-ink"
        />
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

/**
 * Whether a draft can be sent. Blank is allowed — the runner calls — so
 * only the lengths are checked here; the database checks them again.
 */
export function spotProblem(draft: SpotDraft | null): string | null {
  if (!draft) return null;
  if (draft.spot.length > 60) return "Keep the spot short — a place name.";
  if (draft.detail.length > 60) return "Keep the detail short — a room number, or where exactly.";
  return null;
}
