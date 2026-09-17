"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A notification from the page itself, for a desk whose tab is open but not
 * in front. Android Chrome only allows these through a service worker
 * (`new Notification()` throws there), so the registration shows it when
 * there is one, the constructor otherwise, and neither failing is an error
 * — the chime and the badge have already done their job.
 */
async function showLocal(title: string, body: string, tag: string): Promise<void> {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const options = { body, tag, icon: "/desk-icon-192.png" };
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
    new Notification(title, options);
  } catch {
    /* no way to show one here; the sound and the badge still happened */
  }
}

const STORAGE_KEY = "printify.operator.alert";

/**
 * Tells the operator a job has arrived when they aren't looking at the screen.
 *
 * The portal already updates live, but that only helps somebody watching it —
 * and an operator at the machine isn't. A short tone plus a browser
 * notification is the difference between a two-minute response and a
 * twenty-minute one.
 *
 * The tone is synthesised rather than shipped as an audio file: no asset to
 * load, no failure if it 404s, and it can't be blocked as third-party media.
 */
export function useNewOrderAlert(pendingCount: number | null, paid?: PaidSignal) {
  const [enabled, setEnabled] = useState(false);
  const previous = useRef<number | null>(null);
  const previousPaid = useRef<number | null>(null);
  const audio = useRef<AudioContext | null>(null);

  useEffect(() => {
    try {
      setEnabled(localStorage.getItem(STORAGE_KEY) === "on");
    } catch {
      /* private mode — the alert simply stays off */
    }
  }, []);

  const chime = useCallback((notes: readonly (readonly [number, number])[] = NEW_ORDER_NOTES) => {
    try {
      audio.current ??= new AudioContext();
      const ctx = audio.current;
      // Autoplay policy suspends the context until a gesture; enabling the
      // alert is that gesture, so this only needs a nudge on later plays.
      if (ctx.state === "suspended") void ctx.resume();

      const now = ctx.currentTime;
      // Two short notes — distinct from a phone notification, easy to hear
      // over a printer without being startling.
      for (const [at, freq] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.18);
      }
    } catch {
      /* no audio device, or blocked — the visual badge still updates */
    }
  }, []);

  const notify = useCallback((count: number) => {
    void showLocal("New print order", count === 1 ? "One order is waiting to be accepted." : `${count} orders are waiting.`, "printify-new-order");
  }, []);

  useEffect(() => {
    if (pendingCount === null) return;

    const before = previous.current;
    previous.current = pendingCount;

    // Only a genuine increase counts: the first load and an order being
    // accepted must both stay silent.
    if (before === null || pendingCount <= before || !enabled) return;

    chime();
    notify(pendingCount);
  }, [pendingCount, enabled, chime, notify]);

  // A payment through Printifi: the order skips New and lands in the queue
  // already paid, so the count above never rises for it. Its own three
  // notes, and a notification that names the token.
  useEffect(() => {
    if (!paid) return;
    const before = previousPaid.current;
    previousPaid.current = paid.count;
    if (before === null || paid.count <= before || !enabled) return;
    chime(PAID_NOTES);
    void showLocal("Paid online", paid.latest ? `${paid.latest} is paid and in the queue.` : "An order was paid and is in the queue.", "printify-paid-online");
  }, [paid, enabled, chime]);

  const toggle = useCallback(async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      /* ignore */
    }

    if (next) {
      // Unlock audio on the gesture that turned it on, and play once so the
      // operator knows what they're listening for.
      chime();
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        await Notification.requestPermission();
      }
    }
  }, [enabled, chime]);

  return { enabled, toggle };
}

/** How many payments through Printifi this screen has seen land, and the newest one's token and amount. */
export interface PaidSignal {
  count: number;
  latest: string | null;
}

const NEW_ORDER_NOTES = [[0, 880], [0.18, 1175]] as const;
// Rising, one more than the new-order chime: money in, nothing to check.
const PAID_NOTES = [[0, 784], [0.14, 988], [0.28, 1319]] as const;

export function AlertToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={enabled}
      title={enabled ? "Sound on for new orders" : "Sound off — you'll only see the badge"}
      className={cn(
        "flex h-11 shrink-0 items-center gap-2 rounded-xl border px-3.5 text-[12.5px] font-semibold transition-colors",
        enabled
          ? "border-sage bg-sage text-sage-ink"
          : "border-line bg-surface text-muted hover:text-ink-soft",
      )}
    >
      {enabled ? <Volume2 size={14} strokeWidth={2.2} /> : <BellOff size={14} strokeWidth={2.2} />}
      <span className="hidden sm:inline">{enabled ? "Alerts on" : "Alerts off"}</span>
      {!enabled && <Bell size={0} />}
    </button>
  );
}
