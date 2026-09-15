"use client";

import type { Operator } from "./orders";

/**
 * Paying through Printify, from the browser's side.
 *
 * The server holds the Cashfree secret and makes the order; the browser
 * only ever sees a payment session id, opens Cashfree's own checkout with
 * it (UPI intent, cards, netbanking — Cashfree's page, not ours), and then
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
  return gatewayMode() !== null && (operator?.gateway_status === "active" || operator?.gateway_status === "collect");
}

/** One of Cashfree's mountable elements: a UPI app button, a QR, a collect field. */
export interface CashfreeElement {
  /** A CSS selector. Not a node: the SDK serialises its arguments, and a React-owned node is circular. */
  mount(selector: string): void;
  unmount?(): void;
  on(event: "ready" | "click" | "loaderror" | "change", handler: (e?: unknown) => void): void;
  isComplete?(): boolean;
}

export interface PayResult {
  error?: { message?: string };
  redirect?: boolean;
  paymentDetails?: { paymentMessage?: string };
}

interface CashfreeSdk {
  checkout(opts: { paymentSessionId: string; redirectTarget: "_modal" | "_self" | "_blank" }): Promise<PayResult>;
  create(type: "upiApp" | "upiQr" | "upiCollect", opts: { values?: Record<string, unknown>; style?: Record<string, unknown> }): CashfreeElement;
  pay(opts: {
    paymentMethod: CashfreeElement;
    paymentSessionId: string;
    returnUrl?: string;
    redirect?: "if_required" | "always";
    redirectTarget?: "_self" | "_blank" | "_modal";
  }): Promise<PayResult>;
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

/** Cashfree's SDK handle, loaded on demand. */
export async function sdk(mode: GatewayMode): Promise<CashfreeSdk> {
  await loadSdk();
  return window.Cashfree!({ mode });
}

/**
 * Did the money arrive? The server asks Cashfree, with patience for the
 * webhook; "pending" means not yet — the order's realtime row will move
 * on its own when it does.
 */
export async function awaitPaid(orderId: string, tries = 8): Promise<OnlineOutcome> {
  for (let i = 0; i < tries; i++) {
    const check = await fetch(`/api/payments/status?order=${encodeURIComponent(orderId)}`, { cache: "no-store" });
    const status = (await check.json().catch(() => ({}))) as { paid?: boolean };
    if (status.paid) return { kind: "paid" };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { kind: "pending" };
}

/** What a pay() result means, in the same words the modal's did. */
export function outcomeOf(result: PayResult): OnlineOutcome | null {
  if (result.error) {
    const message = result.error.message ?? "";
    if (/closed|cancel|dropped|back/i.test(message)) return { kind: "cancelled" };
    return { kind: "error", message: message || "The payment didn't go through." };
  }
  return null;
}

/** The UPI apps Cashfree can open directly, in the order students reach for them. */
export const CASHFREE_APPS = [
  { id: "gpay", label: "Google Pay" },
  { id: "phonepe", label: "PhonePe" },
  { id: "paytm", label: "Paytm" },
] as const;

/**
 * Pay through one of Cashfree's own elements — a UPI app button, a QR, a
 * collect request. Cashfree signs the intent, so the app opens with the
 * amount filled in and no hosted page in between; when the student comes
 * back, the server is asked whether it landed.
 */
export async function payWithElement(cf: CashfreeSdk, element: CashfreeElement, session: OnlineSession, orderId: string): Promise<OnlineOutcome> {
  let result: PayResult;
  try {
    result = await cf.pay({
      paymentMethod: element,
      paymentSessionId: session.paymentSessionId,
      returnUrl: `${window.location.origin}/orders?paid=${orderId}`,
      redirect: "if_required",
    });
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : "The payment didn't start." };
  }
  const early = outcomeOf(result);
  if (early) return early;
  return awaitPaid(orderId);
}

/**
 * The whole thing: session from the server, Cashfree's checkout in a
 * modal, then the server asked whether it went through — a few times,
 * because the webhook and the checkout closing race by seconds. "pending"
 * means the checkout closed and Cashfree hasn't said yet; the order's
 * realtime row will move on its own when it does.
 */
export async function payOnline(orderId: string): Promise<OnlineOutcome> {
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

  return payHosted({ paymentSessionId: session.paymentSessionId, mode: session.mode ?? mode }, orderId);
}

/** Cashfree's hosted checkout in a modal — cards, netbanking, and the fallback when an element can't mount. */
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
