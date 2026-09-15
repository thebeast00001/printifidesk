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

/** Whether this desk can be paid through Printify: the deployment has Cashfree, and Cashfree said the desk's vendor is active. */
export function canPayOnline(operator: Operator | null | undefined): boolean {
  return gatewayMode() !== null && operator?.gateway_status === "active";
}

interface CashfreeSdk {
  checkout(opts: { paymentSessionId: string; redirectTarget: "_modal" | "_self" | "_blank" }): Promise<{
    error?: { message?: string };
    redirect?: boolean;
    paymentDetails?: { paymentMessage?: string };
  }>;
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

  try {
    await loadSdk();
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : "Couldn't load the checkout." };
  }
  const cashfree = window.Cashfree!({ mode: session.mode ?? mode });
  const result = await cashfree.checkout({ paymentSessionId: session.paymentSessionId, redirectTarget: "_modal" });
  if (result.error) {
    // Closing the modal without paying comes back as an "error" too.
    const message = result.error.message ?? "";
    if (/closed|cancel|dropped/i.test(message)) return { kind: "cancelled" };
    return { kind: "error", message: message || "The payment didn't go through." };
  }

  // Did it? Ask, with a little patience for the webhook.
  for (let i = 0; i < 8; i++) {
    const check = await fetch(`/api/payments/status?order=${encodeURIComponent(orderId)}`, { cache: "no-store" });
    const status = (await check.json().catch(() => ({}))) as { paid?: boolean };
    if (status.paid) return { kind: "paid" };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { kind: "pending" };
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
