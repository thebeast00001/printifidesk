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

/** The same answer as operator_open_at(): switch, schedule, closed day, not shut. */
export function isOpenAt(op: HoursSource, at: Date = new Date()): boolean {
  if (!op.is_open || op.shut_at) return false;
  return scheduleOpenAt(op, at);
}

/**
 * The next thing the schedule does, in words: "till 6 PM" while open;
 * "opens 9 AM", "opens Mon 9 AM", or nothing when no day in the coming
 * week has hours.
 */
export function nextChange(op: HoursSource, at: Date = new Date()): string | null {
  const { day, date } = localParts(at, op.tz);
  const today = hoursOn(op, day);
  if (scheduleOpenAt(op, at) && today) {
    const till = clockLabel(today.close);
    return till ? `till ${till}` : null;
  }
  // Later today, if it opens later today.
  const { minutes } = localParts(at, op.tz);
  if (today && !(op.closed_on ?? []).includes(date) && toMinutes(today.open)! > minutes) {
    const opens = clockLabel(today.open);
    return opens ? `opens ${opens}` : null;
  }
  // Else the next day with hours, up to a week out.
  for (let i = 1; i <= 7; i++) {
    const next = new Date(at.getTime() + i * 86_400_000);
    const p = localParts(next, op.tz);
    if ((op.closed_on ?? []).includes(p.date)) continue;
    const h = hoursOn(op, p.day);
    if (!h) continue;
    const opens = clockLabel(h.open);
    const dayName = i === 1 ? "tomorrow" : DAY_LABEL[p.day].slice(0, 3);
    return opens ? `opens ${dayName} ${opens}` : null;
  }
  return null;
}
