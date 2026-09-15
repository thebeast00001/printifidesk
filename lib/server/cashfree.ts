import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cashfree Payment Gateway, with Easy Split.
 *
 * Server only — the secret never reaches a browser. Everything here is a
 * thin, typed call to Cashfree's REST API (version 2023-08-01): create an
 * order (with the split to the desk's vendor), read it back, create and
 * read a vendor, refund, and verify a webhook's signature. No retries and
 * no cleverness: a failure is returned as a message and shown.
 *
 *   CASHFREE_APP_ID      the client id from the merchant dashboard
 *   CASHFREE_SECRET_KEY  the client secret — also what signs webhooks
 *   CASHFREE_ENV         "sandbox" (default) or "production"
 *
 * Unset, `cashfreeConfigured()` is false and nothing in the app offers
 * online payment; the direct-to-desk UPI flows carry on as before.
 */

export const API_VERSION = "2023-08-01";

export type CashfreeEnv = "sandbox" | "production";

export function cashfreeEnv(): CashfreeEnv {
  return process.env.CASHFREE_ENV === "production" ? "production" : "sandbox";
}

export function cashfreeConfigured(): boolean {
  return Boolean(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
}

function base(): string {
  return cashfreeEnv() === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-version": API_VERSION,
    "x-client-id": process.env.CASHFREE_APP_ID ?? "",
    "x-client-secret": process.env.CASHFREE_SECRET_KEY ?? "",
  };
}

export class CashfreeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!cashfreeConfigured()) throw new CashfreeError("Cashfree isn't configured on this deployment.", 503);
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json ?? {}) as { message?: string; code?: string; type?: string };
    throw new CashfreeError(err.message || `Cashfree answered ${res.status}`, res.status, err.code);
  }
  return json as T;
}

/* ---------- orders ---------- */

export interface CreateOrderInput {
  /** 3–45 chars: letters, digits, - and _. Unique per Cashfree account. */
  orderId: string;
  amount: number;
  customer: { id: string; phone: string; email?: string | null; name?: string | null };
  note?: string;
  returnUrl: string;
  notifyUrl: string;
  /** Easy Split: the desk's share to its vendor; the rest stays with Printify. */
  split?: { vendorId: string; amount: number } | null;
  tags?: Record<string, string>;
}

export interface CashfreeOrder {
  cf_order_id: string;
  order_id: string;
  order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED";
  order_amount: number;
  payment_session_id: string;
  order_expiry_time?: string;
}

export function createOrder(input: CreateOrderInput): Promise<CashfreeOrder> {
  return call<CashfreeOrder>("POST", "/orders", {
    order_id: input.orderId,
    order_amount: Number(input.amount.toFixed(2)),
    order_currency: "INR",
    customer_details: {
      customer_id: input.customer.id,
      customer_phone: input.customer.phone,
      ...(input.customer.email ? { customer_email: input.customer.email } : {}),
      ...(input.customer.name ? { customer_name: input.customer.name } : {}),
    },
    ...(input.note ? { order_note: input.note } : {}),
    order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
    ...(input.tags ? { order_tags: input.tags } : {}),
    ...(input.split
      ? { order_splits: [{ vendor_id: input.split.vendorId, amount: Number(input.split.amount.toFixed(2)) }] }
      : {}),
  });
}

export function getOrder(orderId: string): Promise<CashfreeOrder> {
  return call<CashfreeOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
}

export interface CashfreePayment {
  cf_payment_id: string | number;
  payment_status: "SUCCESS" | "NOT_ATTEMPTED" | "FAILED" | "USER_DROPPED" | "VOID" | "CANCELLED" | "PENDING";
  payment_amount: number;
  payment_currency: string;
  payment_time?: string;
  payment_group?: string;
  payment_message?: string;
  bank_reference?: string | null;
}

export function getPayments(orderId: string): Promise<CashfreePayment[]> {
  return call<CashfreePayment[]>("GET", `/orders/${encodeURIComponent(orderId)}/payments`);
}

/* ---------- refunds ---------- */

export interface RefundInput {
  orderId: string;
  refundId: string;
  amount: number;
  note?: string;
  /** Easy Split: how much of it comes out of the vendor's share. */
  splits?: { vendorId: string; amount: number }[];
}

export interface CashfreeRefund {
  cf_refund_id?: string | number;
  refund_id: string;
  refund_status: string;
  refund_amount: number;
}

export function createRefund(input: RefundInput): Promise<CashfreeRefund> {
  return call<CashfreeRefund>("POST", `/orders/${encodeURIComponent(input.orderId)}/refunds`, {
    refund_amount: Number(input.amount.toFixed(2)),
    refund_id: input.refundId,
    ...(input.note ? { refund_note: input.note.slice(0, 100) } : {}),
    ...(input.splits && input.splits.length
      ? { refund_splits: input.splits.map((s) => ({ vendor_id: s.vendorId, amount: Number(s.amount.toFixed(2)) })) }
      : {}),
  });
}

/* ---------- Easy Split vendors ---------- */

export interface VendorInput {
  /** Letters, digits and underscore. */
  vendorId: string;
  name: string;
  email: string;
  phone: string;
  bank?: { accountNumber: string; accountHolder: string; ifsc: string } | null;
  upi?: { vpa: string; accountHolder: string } | null;
  kyc: { accountType: "INDIVIDUAL" | "BUSINESS"; businessType?: string | null; pan?: string | null };
}

export interface CashfreeVendor {
  vendor_id: string;
  status: string;
  name?: string;
  email?: string;
  phone?: string | number;
}

export function createVendor(input: VendorInput): Promise<CashfreeVendor> {
  return call<CashfreeVendor>("POST", "/easy-split/vendors", {
    vendor_id: input.vendorId,
    status: "ACTIVE",
    name: input.name,
    email: input.email,
    phone: input.phone,
    verify_account: true,
    dashboard_access: false,
    // Settle to the vendor every day.
    schedule_option: 1,
    ...(input.bank
      ? { bank: { account_number: input.bank.accountNumber, account_holder: input.bank.accountHolder, ifsc: input.bank.ifsc } }
      : {}),
    ...(input.upi ? { upi: { vpa: input.upi.vpa, account_holder: input.upi.accountHolder } } : {}),
    kyc_details: {
      account_type: input.kyc.accountType,
      ...(input.kyc.businessType ? { business_type: input.kyc.businessType } : {}),
      ...(input.kyc.pan ? { pan: input.kyc.pan } : {}),
    },
  });
}

export function getVendor(vendorId: string): Promise<CashfreeVendor> {
  return call<CashfreeVendor>("GET", `/easy-split/vendors/${encodeURIComponent(vendorId)}`);
}

/**
 * Cashfree's own vendor states, folded to what the app shows. ACTIVE is
 * the only one that can take a split; the rest are Cashfree still
 * verifying the bank account, or having refused it.
 */
export function vendorStatus(cashfreeStatus: string | undefined): "pending" | "active" | "blocked" {
  const s = (cashfreeStatus ?? "").toUpperCase();
  if (s === "ACTIVE") return "active";
  if (s === "BLOCKED" || s === "DELETED" || s === "BENE_CREATION_FAILED" || s === "REJECTED") return "blocked";
  return "pending";
}

/* ---------- webhooks ---------- */

/**
 * Cashfree signs `timestamp + rawBody` with the client secret, HMAC-SHA256,
 * base64. The raw bytes, not a re-serialised JSON — reserialising turns
 * 14.00 into 14 and the signature no longer matches.
 */
export function webhookSignature(timestamp: string, rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}${rawBody}`, "utf8").digest("base64");
}

export function verifyWebhook(rawBody: string, timestamp: string | null, signature: string | null, secret: string): boolean {
  if (!timestamp || !signature || !secret) return false;
  const expected = Buffer.from(webhookSignature(timestamp, rawBody, secret), "utf8");
  const given = Buffer.from(signature, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface PaymentWebhook {
  type: "PAYMENT_SUCCESS_WEBHOOK" | "PAYMENT_FAILED_WEBHOOK" | "PAYMENT_USER_DROPPED_WEBHOOK" | string;
  event_time?: string;
  data: {
    order: { order_id: string; order_amount: number; order_currency?: string };
    payment: {
      cf_payment_id: string | number;
      payment_status: string;
      payment_amount: number;
      payment_currency?: string;
      payment_time?: string;
      payment_group?: string;
      payment_message?: string;
      bank_reference?: string | null;
    };
  };
}

/* ---------- ids ---------- */

/**
 * Cashfree wants 3–45 of [A-Za-z0-9_-], unique for the account. The order's
 * uuid without dashes is 32; a prefix says what it is, and an attempt
 * suffix lets a new Cashfree order be made for the same Printify order
 * when the previous one expired.
 */
export function gatewayOrderId(orderId: string, attempt = 1): string {
  const hex = orderId.replace(/-/g, "").slice(0, 32);
  return attempt <= 1 ? `PF${hex}` : `PF${hex}-${attempt}`;
}

/** What goes to the desk's vendor: the bill less Printify's fee. Rounding stays with the desk. */
export function vendorShare(total: number, platformFee: number): number {
  return Math.max(0, Math.round((total - platformFee) * 100) / 100);
}
