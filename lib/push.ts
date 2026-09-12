"use client";

import { ensureSession, getSupabase } from "./supabase/client";

/**
 * Web push subscription, browser side.
 *
 * Push is the only channel that reaches a student who closed the tab and needs
 * no provider account, no phone number and no per-message cost — the keys are
 * generated locally and the browser vendor's own push service does the
 * delivery.
 */

export const PUSH_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export type PushState =
  | "unsupported"
  | "unconfigured"
  | "denied"
  | "off"
  | "on"
  | "checking";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * VAPID keys travel as base64url; PushManager wants raw bytes.
 *
 * Backed by an explicit ArrayBuffer because a plain `Uint8Array` is typed over
 * `ArrayBufferLike`, which could be a SharedArrayBuffer and isn't accepted as a
 * BufferSource.
 */
function urlBase64ToBytes(base64: string): ArrayBuffer {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/sw.js");
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (!PUSH_PUBLIC_KEY) return "unconfigured";
  if (Notification.permission === "denied") return "denied";

  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    return sub ? "on" : "off";
  } catch {
    return "off";
  }
}

/**
 * Asks permission, subscribes, and stores the keys.
 *
 * The endpoint is unique per browser+device, so the same account on a phone and
 * a laptop is two rows and gets both. `desk` marks a subscription made on the
 * desk site: that device gets the desk's new-order pushes as well.
 */
export async function enablePush({ desk = false }: { desk?: boolean } = {}): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (!PUSH_PUBLIC_KEY) return "unconfigured";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const session = await ensureSession();
  if (session.status !== "ready") return "off";

  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(PUSH_PUBLIC_KEY),
    }));

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return "off";

  const supabase = getSupabase();
  const { error } = await supabase!.from("push_subscriptions").upsert(
    {
      user_id: session.userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent.slice(0, 200),
      failed_at: null,
      desk,
      // The key this subscription was made with. A push signed with any other
      // private key is refused by the push service, so the dispatcher checks.
      vapid_key: PUSH_PUBLIC_KEY,
    },
    { onConflict: "endpoint" },
  );

  if (error) throw new Error(error.message);
  return "on";
}

export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";

  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();

  if (sub) {
    const supabase = getSupabase();
    // Remove the row first: a subscription that unsubscribes but stays in the
    // table becomes a permanent failing send.
    await supabase?.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }

  return "off";
}
