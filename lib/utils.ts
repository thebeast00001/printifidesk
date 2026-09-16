import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** iOS-style spring. Used for anything that morphs rather than fades. */
export const spring = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 } as const;
export const easeIos = [0.32, 0.72, 0, 1] as const;

/**
 * A Postgres `time` — "20:00:00" — as a person says it: "8 PM", "9:30 AM".
 *
 * Done by hand rather than through `toLocaleTimeString`, which on a phone set
 * to a 24-hour clock returns "20" and no meridiem. The operator typed a time
 * of day; the student should read one, whatever their locale.
 */
export function clockLabel(time: string | null | undefined): string | null {
  if (!time) return null;
  const [h, m] = time.split(":").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  const hour12 = h % 12 || 12;
  const minutes = Number.isFinite(m) && m > 0 ? `:${String(m).padStart(2, "0")}` : "";
  return `${hour12}${minutes} ${h < 12 ? "AM" : "PM"}`;
}
