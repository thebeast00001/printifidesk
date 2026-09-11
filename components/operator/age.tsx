"use client";

import { useEffect, useState } from "react";
import type { Operator, OrderRow } from "@/lib/orders";
import { cn } from "@/lib/utils";

/**
 * A clock that ticks once a minute — enough for "waiting 12 min", and cheap
 * enough to share across every card on the screen without each one running
 * its own timer.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export const minutesSince = (iso: string | null | undefined, now: number): number | null =>
  iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000)) : null;

/**
 * What the desk's own rate card implies this job should take: the fixed
 * handling time plus the pages at the machine's measured speed. The same two
 * numbers the student's wait estimate is built from, so "late" here means
 * late against what they were told.
 */
export function promisedMinutes(order: OrderRow, operator: Operator): number {
  const copies = Math.max(1, Number(order.config?.copies ?? 1));
  const ppm = Math.max(1, Number(operator.pages_per_minute) || 20);
  return Number(operator.handling_minutes || 3) + Math.ceil((order.pages * copies) / ppm);
}

export type Urgency = "fine" | "late" | "very-late";

/**
 * Where the clock started and how far it may run before this row wants
 * attention. Different for each stage because each stage waits on a
 * different person.
 */
export function ageOf(
  order: OrderRow,
  operator: Operator,
  now: number,
): { minutes: number; label: string; urgency: Urgency } | null {
  switch (order.status) {
    case "placed": {
      // Waiting on money, or on the desk noticing. Ten minutes is a student
      // standing there wondering; twenty is one who has walked off.
      const m = minutesSince(order.created_at, now);
      if (m === null) return null;
      return { minutes: m, label: `waiting ${m} min`, urgency: m >= 20 ? "very-late" : m >= 10 ? "late" : "fine" };
    }
    case "queued":
    case "printing":
    case "finishing": {
      const m = minutesSince(order.queued_at ?? order.created_at, now);
      if (m === null) return null;
      const promised = promisedMinutes(order, operator);
      return {
        minutes: m,
        label: `${m} min in`,
        urgency: m >= promised * 2 ? "very-late" : m >= promised ? "late" : "fine",
      };
    }
    case "ready": {
      // Waiting on the student now. Half an hour on the shelf is normal;
      // two hours is a nudge; longer is a slip about to be lost.
      const m = minutesSince(order.ready_at ?? order.created_at, now);
      if (m === null) return null;
      return {
        minutes: m,
        label: m >= 60 ? `on the shelf ${Math.floor(m / 60)} h ${m % 60} min` : `on the shelf ${m} min`,
        urgency: m >= 120 ? "very-late" : m >= 30 ? "late" : "fine",
      };
    }
    default:
      return null;
  }
}

export function AgeBadge({
  order,
  operator,
  now,
  className,
}: {
  order: OrderRow;
  operator: Operator;
  now: number;
  className?: string;
}) {
  const age = ageOf(order, operator, now);
  if (!age) return null;
  return (
    <span
      title={
        order.status === "queued" || order.status === "printing" || order.status === "finishing"
          ? `Your rate card says about ${promisedMinutes(order, operator)} min for this job`
          : undefined
      }
      className={cn(
        "rounded-full px-2.5 py-1 font-mono text-[10.5px] font-medium whitespace-nowrap",
        age.urgency === "very-late"
          ? "bg-clay text-clay-ink"
          : age.urgency === "late"
            ? "bg-clay/40 text-clay-ink"
            : "bg-surface-sunk text-muted",
        className,
      )}
    >
      {age.label}
    </span>
  );
}

/** For a scheduled job: how far off the booked pickup is, or how far past. */
export function DueBadge({ order, now }: { order: OrderRow; now: number }) {
  if (!order.pickup_at) return null;
  const diff = Math.round((new Date(order.pickup_at).getTime() - now) / 60_000);
  const abs = Math.abs(diff);
  const span = abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`;
  const label = diff >= 0 ? `due in ${span}` : `due ${span} ago`;
  const urgency: Urgency = diff < 0 ? "very-late" : diff <= 30 ? "late" : "fine";
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 font-mono text-[10.5px] font-medium whitespace-nowrap",
        urgency === "very-late"
          ? "bg-clay text-clay-ink"
          : urgency === "late"
            ? "bg-sage text-sage-ink"
            : "bg-surface-sunk text-muted",
      )}
    >
      {label}
    </span>
  );
}

/** "Today 2 PM" — the heading a scheduled job files under. */
export function hourLabel(iso: string, now: number): string {
  const at = new Date(iso);
  const today = new Date(now);
  const sameDay = at.toDateString() === today.toDateString();
  const tomorrow = new Date(now + 86_400_000);
  const day = sameDay
    ? "Today"
    : at.toDateString() === tomorrow.toDateString()
      ? "Tomorrow"
      : at.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const hour = new Date(at);
  hour.setMinutes(0, 0, 0);
  return `${day} ${hour.toLocaleTimeString([], { hour: "numeric" })}`;
}
