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
 */

/** `name@bank` — letters, digits, a few punctuation marks, then a handle. */
const VPA_PATTERN = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/;

export function isValidVpa(vpa: string): boolean {
  return VPA_PATTERN.test(vpa.trim());
}

export interface UpiRequest {
  vpa: string;
  payeeName: string;
  amount: number;
  /** Shown in the payer's app and in the operator's statement. */
  note: string;
  /** Transaction reference — the order token, so it can be matched later. */
  reference: string;
}

/**
 * Builds the `upi://pay` URI.
 *
 * Amount must be a plain decimal with at most two places; some UPI apps reject
 * a value with grouping separators or more precision, and the failure is a
 * silent "invalid request" rather than anything useful.
 */
export function upiLink({ vpa, payeeName, amount, note, reference }: UpiRequest): string {
  const params = new URLSearchParams({
    pa: vpa.trim(),
    pn: payeeName.trim(),
    am: amount.toFixed(2),
    cu: "INR",
    tn: note.slice(0, 50),
    tr: reference.slice(0, 35),
  });
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
