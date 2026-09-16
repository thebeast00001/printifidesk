/**
 * A desk's hours (0039): by weekday, with days closed, in the desk's own
 * timezone. `operator_open_at()` in the database is the one answer to
 * "open now?"; this is the same reading in the browser, for labels — "till
 * 6 PM", "opens Mon 9 AM" — and for the pickup picker's day. Nothing here
 * decides whether an order goes through; the database does that.
 */

import { clockLabel } from "./utils";

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const DAY_KEYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_LABEL: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** "09:00"–"18:00"; null is a day off. */
export interface DayHours {
  open: string;
  close: string;
}
export type WeeklyHours = Partial<Record<DayKey, DayHours | null>>;

/** The shape of the row this reads — a subset of Operator. */
export interface HoursSource {
  is_open: boolean;
  shut_at?: string | null;
  opens_at?: string | null;
  closes_at?: string | null;
  hours?: WeeklyHours | null;
  closed_on?: string[] | null;
  tz?: string | null;
  /** 0041: when the switch was last flipped. A flip since the schedule's last change wins over the schedule. */
  open_set_at?: string | null;
}

const HHMM = /^([0-2]\d):([0-5]\d)/;

/** "09:00:00" or "09:00" → minutes since midnight; null when unreadable. */
export function toMinutes(value: string | null | undefined): number | null {
  const m = HHMM.exec(value ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 ? null : h * 60 + min;
}

/** Wall-clock parts of an instant in the desk's timezone. */
export function localParts(at: Date, tz: string | null | undefined): { day: DayKey; minutes: number; date: string } {
  const zone = tz && tz.trim() ? tz : "Asia/Kolkata";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const day = get("weekday").slice(0, 3).toLowerCase() as DayKey;
  // "24" is what some engines print for midnight with hour12:false.
  const hour = Number(get("hour")) % 24;
  return {
    day: DAY_KEYS.includes(day) ? day : "mon",
    minutes: hour * 60 + Number(get("minute")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/**
 * The desk's hours on a given weekday: the weekly entry if it has one,
 * else opens_at–closes_at, the way every desk worked before 0039. Null
 * is a day off.
 */
export function hoursOn(op: HoursSource, day: DayKey): DayHours | null {
  if (op.hours && typeof op.hours === "object") {
    if (!(day in op.hours)) return null;
    const entry = op.hours[day];
    if (!entry) return null;
    return toMinutes(entry.open) !== null && toMinutes(entry.close) !== null ? entry : null;
  }
  const open = op.opens_at?.slice(0, 5);
  const close = op.closes_at?.slice(0, 5);
  return open && close ? { open, close } : null;
}

/** Whether the desk's schedule has it open at this instant — the switch and the admin aside. */
export function scheduleOpenAt(op: HoursSource, at: Date = new Date()): boolean {
  const { day, minutes, date } = localParts(at, op.tz);
  if ((op.closed_on ?? []).includes(date)) return false;
  // Today's hours; a day closing after midnight is open from its opening on.
  const h = hoursOn(op, day);
  if (h) {
    const open = toMinutes(h.open)!;
    const close = toMinutes(h.close)!;
    if (close > open ? minutes >= open && minutes < close : minutes >= open) return true;
  }
  // The small hours of a day that closed after midnight belong to yesterday's entry.
  const y = hoursOn(op, DAY_KEYS[(DAY_KEYS.indexOf(day) + 6) % 7]);
  if (y) {
    const open = toMinutes(y.open)!;
    const close = toMinutes(y.close)!;
    if (close < open && minutes < close) return true;
  }
  return false;
}

/**
 * Every moment the schedule changes state in a window of days around `at`,
 * as instants — each day's opening and closing (a close past midnight
 * lands on the next day). Days marked closed contribute none. Sorted.
 */
function boundaries(op: HoursSource, at: Date, daysBack: number, daysAhead: number): { at: Date; opens: boolean }[] {
  const out: { at: Date; opens: boolean }[] = [];
  for (let d = -daysBack; d <= daysAhead; d++) {
    const probe = new Date(at.getTime() + d * 86_400_000);
    const parts = localParts(probe, op.tz);
    if ((op.closed_on ?? []).includes(parts.date)) continue;
    const h = hoursOn(op, parts.day);
    if (!h) continue;
    const open = toMinutes(h.open)!;
    const close = toMinutes(h.close)!;
    const dayStart = zonedMidnight(parts.date, op.tz);
    if (!dayStart) continue;
    out.push({ at: new Date(dayStart.getTime() + open * 60_000), opens: true });
    out.push({ at: new Date(dayStart.getTime() + (close <= open ? close + 1440 : close) * 60_000), opens: false });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The instant of local midnight on a calendar date in the desk's timezone. */
function zonedMidnight(date: string, tz: string | null | undefined): Date | null {
  const zone = tz && tz.trim() ? tz : "Asia/Kolkata";
  // Start from the UTC midnight of that date and correct by the zone's offset at that moment.
  const guess = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(guess.getTime())) return null;
  const local = localParts(guess, zone);
  // The zone's clock at the UTC midnight, in minutes since its own midnight of `local.date`.
  const dayDiff = (new Date(`${local.date}T00:00:00Z`).getTime() - guess.getTime()) / 86_400_000;
  const offsetMinutes = dayDiff * 1440 + local.minutes;
  return new Date(guess.getTime() - offsetMinutes * 60_000);
}

/** The schedule's most recent change at or before `at`, or null with no hours at all. */
export function lastBoundary(op: HoursSource, at: Date = new Date()): Date | null {
  const past = boundaries(op, at, 8, 0).filter((b) => b.at.getTime() <= at.getTime());
  return past.length ? past[past.length - 1].at : null;
}

/** Whether the switch, flipped since the schedule last changed, is what decides right now. */
export function switchDecides(op: HoursSource, at: Date = new Date()): boolean {
  if (!op.open_set_at) return false;
  const boundary = lastBoundary(op, at);
  if (!boundary) return true;
  return new Date(op.open_set_at).getTime() > boundary.getTime();
}

/**
 * The same answer as operator_open_at(): shut by the admin → no; else the
 * switch if it was flipped since the schedule's last change; else the
 * schedule. A desk with no hours at all is its switch alone.
 */
export function isOpenAt(op: HoursSource, at: Date = new Date()): boolean {
  if (op.shut_at) return false;
  if (lastBoundary(op, at) === null) return op.is_open;
  if (switchDecides(op, at)) return op.is_open;
  return scheduleOpenAt(op, at);
}

/** Why the desk reads open or closed right now — for the switch's own caption. */
export function openState(op: HoursSource, at: Date = new Date()): { open: boolean; by: "shut" | "switch" | "schedule" } {
  if (op.shut_at) return { open: false, by: "shut" };
  if (lastBoundary(op, at) === null || switchDecides(op, at)) return { open: op.is_open, by: "switch" };
  return { open: scheduleOpenAt(op, at), by: "schedule" };
}

/** "6 PM", or "tomorrow 9 AM", or "Mon 9 AM" — a boundary named relative to `at`. */
function whenLabel(b: Date, at: Date, tz: string | null | undefined): string | null {
  const here = localParts(at, tz);
  const there = localParts(b, tz);
  const clock = clockLabel(`${String(Math.floor(there.minutes / 60)).padStart(2, "0")}:${String(there.minutes % 60).padStart(2, "0")}`);
  if (!clock) return null;
  if (there.date === here.date) return clock;
  const dayAfter = localParts(new Date(at.getTime() + 86_400_000), tz).date;
  if (there.date === dayAfter) return `tomorrow ${clock}`;
  return `${DAY_LABEL[there.day].slice(0, 3)} ${clock}`;
}

/**
 * The next thing that happens, in words, given what decides right now:
 * open → "till 6 PM" (the next scheduled close); closed → "opens 9 AM",
 * "opens tomorrow 9 AM", "opens Mon 9 AM". Null with no hours, or when
 * nothing changes in the coming week.
 */
export function nextChange(op: HoursSource, at: Date = new Date()): string | null {
  const open = isOpenAt(op, at);
  const ahead = boundaries(op, at, 1, 8).filter((b) => b.at.getTime() > at.getTime());
  if (open) {
    // Opened by the switch outside hours: the next close after the schedule
    // next opens is the honest "till" — the switch holds until then anyway.
    const next = ahead.find((b) => !b.opens);
    const label = next ? whenLabel(next.at, at, op.tz) : null;
    return label ? `till ${label}` : null;
  }
  const next = ahead.find((b) => b.opens);
  const label = next ? whenLabel(next.at, at, op.tz) : null;
  return label ? `opens ${label}` : null;
}
