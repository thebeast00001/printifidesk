/**
 * UPI payment links.
 *
 * No gateway, no merchant account, no KYC, no percentage cut: a `upi://pay`
 * link opens the payer's own UPI app with the amount and a reference already
 * filled in, and the money goes straight from student to operator.
 *
 * The trade-off is real and is handled honestly everywhere this is used —
 * without a gateway webhook, **nothing here can confirm that money arrived**.
 * The student can say they've paid; only the operator, looking at their own UPI
 * app, can confirm it.
 *
 * Two kinds of UPI id, and the apps treat them differently:
 *
 *   merchant  — the id behind a shop's PhonePe Business / Paytm for Business /
 *               GPay Business QR. Links and QRs with the amount pre-filled go
 *               straight through.
 *   personal  — an ordinary `name@bank`. Since 2022 the apps refuse a link or
 *               QR that a third-party site generated *with an amount* for
 *               one of these — "Transaction not allowed", "restricted by the
 *               bank". The only thing that works everywhere is what a
 *               friend's static QR does: no amount in the code, the payer
 *               types it.
 *
 * So `upiLink` takes an optional amount, and whoever builds the link decides
 * from the payee's kind whether to put it in.
 */

/** `name@bank` — letters, digits, a few punctuation marks, then a handle. */
const VPA_PATTERN = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/;

export function isValidVpa(vpa: string): boolean {
  return VPA_PATTERN.test(vpa.trim());
}

export type UpiKind = "personal" | "merchant";

export interface UpiRequest {
  vpa: string;
  payeeName: string;
  /** Leave undefined for a personal payee — the payer types it. */
  amount?: number;
  /** Shown in the payer's app and in the operator's statement. */
  note: string;
  /** Transaction reference — the order token, so it can be matched later. */
  reference: string;
  /** Merchant category code from the shop's own QR, when it had one. */
  merchantCode?: string | null;
}

/**
 * Builds the `upi://pay` URI.
 *
 * Amount must be a plain decimal with at most two places; some UPI apps reject
 * a value with grouping separators or more precision, and the failure is a
 * silent "invalid request" rather than anything useful.
 */
export function upiLink({ vpa, payeeName, amount, note, reference, merchantCode }: UpiRequest): string {
  const params = new URLSearchParams({ pa: vpa.trim(), pn: payeeName.trim() });
  if (merchantCode && /^\d{4}$/.test(merchantCode)) params.set("mc", merchantCode);
  if (amount !== undefined) params.set("am", amount.toFixed(2));
  params.set("cu", "INR");
  params.set("tn", note.slice(0, 50));
  params.set("tr", reference.slice(0, 35));
  // URLSearchParams encodes spaces as "+", which some UPI apps show literally.
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}

/** Apps that take the same URI but want their own scheme on Android. */
export const UPI_APPS = [
  { id: "gpay", label: "Google Pay", scheme: "tez://upi/pay" },
  { id: "phonepe", label: "PhonePe", scheme: "phonepe://pay" },
  { id: "paytm", label: "Paytm", scheme: "paytmmp://pay" },
] as const;

export function appLink(app: (typeof UPI_APPS)[number], request: UpiRequest): string {
  return upiLink(request).replace("upi://pay", app.scheme);
}

export interface ScannedUpi {
  vpa: string;
  name: string | null;
  /** Four digits on a merchant's QR; `0000` or absent on a personal one. */
  merchantCode: string | null;
  kind: UpiKind;
}

/**
 * Reads a shop's own QR. Business QRs (PhonePe Business, Paytm, GPay
 * Business, BharatPe, a bank's) carry `mc`, the merchant category code;
 * a personal QR either has none or `0000`. That one field is what the apps
 * key on, so it's what decides the kind here. Returns null for anything
 * that isn't a UPI QR at all.
 */
export function parseUpiQr(text: string): ScannedUpi | null {
  const raw = text.trim();
  const m = /^upi:\/\/pay\?(.*)$/i.exec(raw);
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  const vpa = (params.get("pa") ?? "").trim();
  if (!isValidVpa(vpa)) return null;
  const mc = (params.get("mc") ?? "").trim();
  const merchantCode = /^\d{4}$/.test(mc) && mc !== "0000" ? mc : null;
  const name = (params.get("pn") ?? "").trim() || null;
  return { vpa, name, merchantCode, kind: merchantCode ? "merchant" : "personal" };
}
