"use client";

import { useMemo } from "react";
import { motion } from "motion/react";
import { cn, spring } from "@/lib/utils";
import type { Operator } from "@/lib/orders";

const SLOT_MINUTES = 30;
/** How far ahead a student can book. Beyond this the queue is guesswork. */
const HORIZON_HOURS = 36;

export interface Slot {
  /** ISO instant the job should be ready by. */
  at: string;
  label: string;
  day: string;
}

/** Parses a Postgres `time` ("09:00:00") into minutes past midnight. */
function timeToMinutes(value: string | null | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Real slots, built from this operator's own opening hours.
 *
 * Only times that are actually in the future and inside their hours are
 * offered, plus enough lead time to print the job — there is no point letting
 * someone book a slot that has already passed or that the machine can't reach.
 */
export function buildSlots(operator: Operator | null, pages: number, now = new Date()): Slot[] {
  if (!operator) return [];

  const opens = timeToMinutes(operator.opens_at, 9 * 60);
  const closes = timeToMinutes(operator.closes_at, 20 * 60);
  if (closes <= opens) return [];

  const ppm = Math.max(Number(operator.pages_per_minute) || 20, 1);
  const leadMinutes = Math.ceil(pages / ppm) + (operator.handling_minutes ?? 3);
  const earliest = new Date(now.getTime() + (leadMinutes + 5) * 60_000);

  const slots: Slot[] = [];
  const horizon = new Date(now.getTime() + HORIZON_HOURS * 3600_000);

  for (let dayOffset = 0; dayOffset <= 2 && slots.length < 24; dayOffset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + dayOffset);

    for (let mins = opens; mins <= closes; mins += SLOT_MINUTES) {
      const at = new Date(day);
      at.setHours(Math.floor(mins / 60), mins % 60, 0, 0);

      if (at < earliest || at > horizon) continue;

      slots.push({
        at: at.toISOString(),
        label: at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        day:
          dayOffset === 0
            ? "Today"
            : dayOffset === 1
              ? "Tomorrow"
              : at.toLocaleDateString([], { weekday: "short" }),
      });
      if (slots.length >= 24) break;
    }
  }

  return slots;
}

export function PickupPicker({
  operator,
  pages,
  value,
  onChange,
}: {
  operator: Operator | null;
  pages: number;
  value: string | null;
  onChange: (at: string | null) => void;
}) {
  const slots = useMemo(() => buildSlots(operator, pages), [operator, pages]);

  const grouped = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const slot of slots) {
      const list = map.get(slot.day) ?? [];
      list.push(slot);
      map.set(slot.day, list);
    }
    return [...map.entries()];
  }, [slots]);

  return (
    <div className="mt-[18px]">
      <p className="label-caps m-0 mb-2.5">Pickup</p>

      <div className="flex flex-wrap gap-[7px]">
        <Choice active={value === null} onClick={() => onChange(null)} label="As soon as possible" />
        {slots.length > 0 && (
          <Choice
            active={value !== null}
            onClick={() => onChange(value ?? slots[0].at)}
            label="Pick a time"
          />
        )}
      </div>

      {value !== null && (
        <div className="mt-3 flex flex-col gap-3">
          {grouped.map(([day, daySlots]) => (
            <div key={day}>
              <p className="m-0 mb-1.5 text-[11.5px] font-semibold text-muted">{day}</p>
              <div className="flex flex-wrap gap-[7px]">
                {daySlots.map((slot) => (
                  <Choice
                    key={slot.at}
                    active={value === slot.at}
                    onClick={() => onChange(slot.at)}
                    label={slot.label}
                    compact
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {value !== null && slots.length === 0 && (
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted">
          No slots left inside opening hours. Send it as soon as possible instead.
        </p>
      )}

      {value === null && (
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted">
          Joins the queue straight away once the operator takes payment.
        </p>
      )}
    </div>
  );
}

function Choice({
  active,
  onClick,
  label,
  compact,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  compact?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      transition={spring}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "relative rounded-xl border text-[13px] font-semibold tracking-[-0.01em]",
        compact ? "px-3 py-2" : "px-3.5 py-2.5",
        active ? "border-ink text-paper" : "border-line bg-surface text-ink-soft",
      )}
    >
      {active && <span className="absolute inset-0 rounded-xl bg-ink" />}
      <span className="relative">{label}</span>
    </motion.button>
  );
}
