import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** iOS-style spring. Used for anything that morphs rather than fades. */
export const spring = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 } as const;
export const springSoft = { type: "spring", stiffness: 260, damping: 30 } as const;
export const easeIos = [0.32, 0.72, 0, 1] as const;
