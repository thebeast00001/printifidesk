"use client";

import { useSyncExternalStore } from "react";
import { PARKED, PARKED_EVENT } from "./install-names";

/**
 * Installing the site as an app, on the student's terms.
 *
 * Chrome (Android, desktop, Edge, Samsung) fires `beforeinstallprompt` once
 * the manifest and service worker qualify, and — left alone — shows its own
 * "Add to Home screen" bar whenever it feels like it. That bar is the
 * "random" prompt. We call `preventDefault()` on the event and keep it, so
 * the browser's prompt only appears when someone taps our Install button.
 *
 * Safari on iOS fires nothing; the install is a Share-sheet gesture. So on
 * iOS the same button opens instructions instead. Anywhere else with no
 * event (Firefox, desktop Safari) there is nothing to offer, and no button.
 *
 * The event can fire before React has hydrated, so the root layout runs an
 * inline script that catches it first and parks it on `window`; this store
 * picks it up from there, and also listens itself in case the script was
 * not there.
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export type Platform = "ios" | "android" | "desktop";

export interface InstallState {
  /** Running as an installed app right now, or installed during this visit. */
  installed: boolean;
  /** The parked Chrome event; `null` where the browser doesn't offer one. */
  prompt: BeforeInstallPromptEvent | null;
  platform: Platform;
  /** The browser's dialog was shown this visit and turned down. Chrome
      hands out one event per page load, so the button now opens the manual
      steps instead of nothing. */
  dismissed: boolean;
  /** False on the server and before the first client read. */
  ready: boolean;
}


/**
 * Where we are, from what the browser says about itself. iPadOS reports
 * itself as a Mac since 13, distinguishable only by having a touch screen.
 */
export function platformFrom(ua: string, maxTouchPoints: number, navPlatform: string): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Mac/i.test(navPlatform) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

/**
 * Whether there is anything to offer: a prompt to fire, iOS steps to show,
 * or — on a phone that has already turned the dialog down — the menu route.
 */
export function canInstall(state: InstallState): boolean {
  if (!state.ready || state.installed) return false;
  return state.prompt !== null || state.platform === "ios" || (state.dismissed && state.platform === "android");
}

const SERVER: InstallState = { installed: false, prompt: null, platform: "desktop", dismissed: false, ready: false };

let state: InstallState = SERVER;
const listeners = new Set<() => void>();
let started = false;

function emit(next: Partial<InstallState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const w = window as Window & { [PARKED]?: BeforeInstallPromptEvent };
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  emit({
    ready: true,
    installed: isStandalone(),
    prompt: w[PARKED] ?? null,
    platform: platformFrom(navigator.userAgent, navigator.maxTouchPoints ?? 0, nav.userAgentData?.platform ?? navigator.platform),
  });
  // The inline script parked one after we first looked.
  window.addEventListener(PARKED_EVENT, () => emit({ prompt: w[PARKED] ?? null }));
  // No inline script (or a CSP that blocked it): catch it here instead.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    emit({ prompt: e as BeforeInstallPromptEvent });
  });
  window.addEventListener("appinstalled", () => emit({ installed: true, prompt: null }));
  window.matchMedia("(display-mode: standalone)").addEventListener("change", (e) => {
    if (e.matches) emit({ installed: true });
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

export function useInstall(): InstallState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER);
}

/**
 * Fires the browser's own install dialog. Only meaningful when `prompt` is
 * set; Chrome allows one call per event, so the event is dropped after.
 */
export async function install(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = state.prompt;
  if (!ev) return "unavailable";
  emit({ prompt: null });
  try {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === "accepted") emit({ installed: true });
    else emit({ dismissed: true });
    return outcome;
  } catch {
    return "unavailable";
  }
}
