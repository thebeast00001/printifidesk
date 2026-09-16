"use client";

import { useSyncExternalStore } from "react";
import type { Operator } from "./orders";

/**
 * Paying through Printify, from the browser's side.
 *
 * The server holds the Cashfree secret and makes the order; the browser
 * only ever sees a payment session id, opens Cashfree's own checkout with
 * it (UPI intent, cards, netbanking — Cashfree's page, in a modal), and then
 * asks the server whether the money arrived. Nothing here can mark an
 * order paid.
 *
 * `NEXT_PUBLIC_CASHFREE_MODE` ("sandbox" | "production") is the browser's
 * only knowledge of Cashfree: which SDK mode to load. Unset, nothing is
 * offered and the direct-to-desk flows stand alone.
 */

export type GatewayMode = "sandbox" | "production";

export function gatewayMode(): GatewayMode | null {
  const m = process.env.NEXT_PUBLIC_CASHFREE_MODE;
  return m === "sandbox" || m === "production" ? m : null;
}

/**
 * Whether this desk can be paid through Printify: the deployment has
 * Cashfree, and the desk is either split at source ("active") or has the
 * admin collecting for it ("collect").
 */
export function canPayOnline(operator: Operator | null | undefined): boolean {
  return (
    gatewayMode() !== null &&
    (operator?.gateway_status === "active" || operator?.gateway_status === "collect") &&
    // 0040: the owner may pause it; the admin's switch-on stays as it was.
    operator?.gateway_paused !== true
  );
}

interface CheckoutResult {
  error?: { message?: string };
  redirect?: boolean;
  paymentDetails?: { paymentMessage?: string };
}

interface CashfreeSdk {
  checkout(opts: { paymentSessionId: string; redirectTarget: "_modal" | "_self" | "_blank" }): Promise<CheckoutResult>;
}

declare global {
  interface Window {
    Cashfree?: (opts: { mode: GatewayMode }) => CashfreeSdk;
  }
}

const SDK_URL = "https://sdk.cashfree.com/js/v3/cashfree.js";
let sdkLoading: Promise<void> | null = null;

/**
 * Cashfree's SDK, loaded once, on demand. A script element created from
 * our own bundle is trusted under the page's strict-dynamic CSP; the
 * checkout it opens is an iframe on cashfree.com, which frame-src allows.
 */
function loadSdk(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  if (window.Cashfree) return Promise.resolve();
  sdkLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => (window.Cashfree ? resolve() : reject(new Error("Cashfree's SDK loaded but didn't register.")));
    script.onerror = () => {
      sdkLoading = null;
      reject(new Error("Couldn't load Cashfree's checkout. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return sdkLoading;
}

export type OnlineOutcome =
  | { kind: "paid" }
  | { kind: "pending" }
  | { kind: "cancelled" }
  | { kind: "needs-phone" }
  | { kind: "error"; message: string };

export interface OnlineSession {
  paymentSessionId: string;
  mode: GatewayMode;
}

export type SessionOutcome = { kind: "session"; session: OnlineSession } | OnlineOutcome;

/**
 * The Cashfree order for this Printify order, from the server. Reused
 * while it's live, so opening the sheet twice makes one order, not two.
 */
export async function openSession(orderId: string): Promise<SessionOutcome> {
  const mode = gatewayMode();
  if (!mode) return { kind: "error", message: "Online payment isn't set up here." };
  const res = await fetch("/api/payments/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId }),
  });
  const session = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    paid?: boolean;
    paymentSessionId?: string;
    mode?: GatewayMode;
    needsPhone?: boolean;
    error?: string;
  };
  if (session.paid) return { kind: "paid" };
  if (session.needsPhone) return { kind: "needs-phone" };
  if (!res.ok || !session.paymentSessionId) return { kind: "error", message: session.error ?? "Couldn't start the payment." };
  return { kind: "session", session: { paymentSessionId: session.paymentSessionId, mode: session.mode ?? mode } };
}

const instances = new Map<GatewayMode, CashfreeSdk>();

/**
 * Cashfree's SDK handle, loaded on demand and kept. Making the instance is
 * not free: the SDK opens a hidden "ping" iframe on cashfree.com the
 * moment it's constructed, and checkout() then *waits* for that ping —
 * polling every 300 ms, giving up after two seconds — before it draws the
 * modal. Made at the tap, that wait sits right under the student's thumb;
 * made when the sheet opens (see warmCheckout), it's over before they've
 * read the amount.
 */
async function sdk(mode: GatewayMode): Promise<CashfreeSdk> {
  const kept = instances.get(mode);
  if (kept) return kept;
  await loadSdk();
  const made = window.Cashfree!({ mode });
  instances.set(mode, made);
  return made;
}

const CASHFREE_HOSTS: Record<GatewayMode, string[]> = {
  production: ["https://api.cashfree.com", "https://payments.cashfree.com"],
  sandbox: ["https://sandbox.cashfree.com", "https://payments-test.cashfree.com"],
};
let warmed = false;

/**
 * Everything the tap will need, started while the sheet is being read:
 * the SDK script, its ping, and connections to the two hosts the checkout
 * posts to and draws from. Safe to call as often as the sheet opens.
 */
export function warmCheckout(mode: GatewayMode): void {
  if (typeof document === "undefined") return;
  if (!warmed) {
    warmed = true;
    for (const href of ["https://sdk.cashfree.com", ...CASHFREE_HOSTS[mode]]) {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = href;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }
  void sdk(mode).catch(() => {
    /* the tap will try again and say why */
  });
}

/**
 * Did the money arrive? The server asks Cashfree, with patience for the
 * webhook; "pending" means not yet — the order's realtime row will move
 * on its own when it does.
 */
export async function awaitPaid(orderId: string, tries = 8): Promise<OnlineOutcome> {
  for (let i = 0; i < tries; i++) {
    const check = await fetch(`/api/payments/status?order=${encodeURIComponent(orderId)}`, { cache: "no-store" });
    const status = (await check.json().catch(() => ({}))) as { paid?: boolean; attempt?: string };
    if (status.paid) return { kind: "paid" };
    // The student backed out of their app, or the bank said no: say so now.
    if (status.attempt === "dropped") return { kind: "cancelled" };
    if (status.attempt === "failed") return { kind: "error", message: "The bank didn't approve it. Nothing was charged — try again or another app." };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { kind: "pending" };
}

/** What the checkout's result means. Closing the modal without paying comes back as an "error" too. */
function outcomeOf(result: CheckoutResult): OnlineOutcome | null {
  if (result.error) {
    const message = result.error.message ?? "";
    if (/closed|cancel|dropped|back/i.test(message)) return { kind: "cancelled" };
    return { kind: "error", message: message || "The payment didn't go through." };
  }
  return null;
}

/**
 * Cashfree's hosted checkout in a modal over the page: UPI (any app, the
 * amount filled in), cards, netbanking. Resolves when the modal closes,
 * then asks the server whether the money landed.
 */
export async function payHosted(session: OnlineSession, orderId: string): Promise<OnlineOutcome> {
  let cashfree: CashfreeSdk;
  try {
    cashfree = await sdk(session.mode);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : "Couldn't load the checkout." };
  }
  const result = await cashfree.checkout({ paymentSessionId: session.paymentSessionId, redirectTarget: "_modal" });
  const early = outcomeOf(result);
  if (early) return early;
  return awaitPaid(orderId);
}

/* ---------- the checkout in flight ---------- */

/**
 * One hosted checkout, from the tap to its outcome, held outside any
 * component. The pay sheet is a modal drawer: while it's open the page
 * outside it takes no pointer events and keeps focus — and Cashfree's
 * modal is appended outside it, so a tap on their UPI button used to land
 * on our backdrop instead, dismissing the sheet, and only the next tap
 * reached Cashfree. So the sheet now closes the moment the checkout opens,
 * the checkout runs here, and the capsule reopens the sheet only when the
 * outcome is something to read (cancelled, pending, failed); paid needs
 * no sheet — the row says so.
 */
export interface CheckoutFlight {
  orderId: string;
  session: OnlineSession;
  phase: "open" | "done";
  outcome: OnlineOutcome | null;
}

let flight: CheckoutFlight | null = null;
const watchers = new Set<() => void>();

function setFlight(next: CheckoutFlight | null) {
  flight = next;
  for (const fn of watchers) fn();
}

/** The checkout in flight, for the capsule to watch. */
export function useCheckoutFlight(): CheckoutFlight | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => flight,
    () => null,
  );
}

/** Opens Cashfree's modal for this order; the outcome lands on the flight, not on the caller. */
export function launchHosted(session: OnlineSession, orderId: string): void {
  setFlight({ orderId, session, phase: "open", outcome: null });
  void payHosted(session, orderId).then((outcome) => {
    if (flight?.orderId === orderId && flight.phase === "open") setFlight({ ...flight, phase: "done", outcome });
  });
}

/** The finished flight for this order, if any — handed over once, then forgotten. */
export function takeFlight(orderId: string): CheckoutFlight | null {
  if (!flight || flight.orderId !== orderId || flight.phase !== "done") return null;
  const done = flight;
  setFlight(null);
  return done;
}

export function clearFlight(): void {
  setFlight(null);
}

/** A refund of a payment made through Printify, asked for by the desk. */
export async function refundOnline(orderId: string, amount: number, note: string): Promise<void> {
  const res = await fetch("/api/payments/refund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId, amount, note }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? "Couldn't refund.");
}

/* ---------- the admin's side ---------- */

export interface VendorForm {
  operatorId: string;
  name: string;
  email: string;
  phone: string;
  accountType: "INDIVIDUAL" | "BUSINESS";
  pan?: string;
  bank?: { accountNumber: string; accountHolder?: string; ifsc: string };
  upi?: { vpa: string; accountHolder?: string };
}

export async function connectDesk(form: VendorForm): Promise<{ status: string; cashfreeStatus: string }> {
  const res = await fetch("/api/payments/vendor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(form),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; cashfreeStatus?: string; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? "Couldn't connect the desk.");
  return { status: body.status ?? "pending", cashfreeStatus: body.cashfreeStatus ?? "" };
}

export async function checkDesk(operatorId: string): Promise<{ status: string; cashfreeStatus?: string }> {
  const res = await fetch(`/api/payments/vendor?operator=${encodeURIComponent(operatorId)}`, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; cashfreeStatus?: string; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? "Couldn't check with Cashfree.");
  return { status: body.status ?? "off", cashfreeStatus: body.cashfreeStatus };
}

/** Forget the desk's vendor here (admin). Cashfree keeps its record; the desk is offered online payment again only once reconnected. */
export async function disconnectDesk(operatorId: string): Promise<void> {
  const res = await fetch(`/api/payments/vendor?operator=${encodeURIComponent(operatorId)}`, { method: "DELETE" });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? "Couldn't disconnect.");
}
