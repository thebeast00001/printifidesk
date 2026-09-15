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

/**
 * `name@bank` — letters, digits, dot, dash, underscore, then a handle.
 * Merchant ids look stranger than personal ones — `Q123456789@ybl`,
 * `paytmqr2810050501011abcd@paytm`, `gpay-11234567890@okbizaxis`,
 * `BHARATPE09912345678@yesbankltd` — and every one of them fits this.
 */
const VPA_PATTERN = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/;

/**
 * Whitespace and the invisible characters a copy from WhatsApp, a PDF or
 * a business app drags along (zero-width spaces, joiners, byte-order
 * marks, soft hyphens). `trim()` takes some of these and not others; an
 * id can't contain any of them, so all go.
 */
const INVISIBLE = /[\s\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD]+/gu;

/**
 * What someone typed or pasted, made into an id. A whole `upi://pay?…`
 * string (some phones copy the QR's text) yields its `pa`; anything else
 * is stripped of what can't be in an id. Case is kept — handles are
 * case-insensitive, but the id is shown back as entered.
 */
export function normaliseVpa(input: string): string {
  const raw = input.replace(INVISIBLE, "");
  const fromQr = /upi:\/\/pay\?/i.test(raw) ? parseUpiQr(raw)?.vpa : null;
  if (fromQr) return fromQr;
  const m = /(?:^|[?&])pa=([^&\s]+)/i.exec(raw);
  if (m) return decodeURIComponent(m[1]).replace(INVISIBLE, "");
  return raw;
}

export function isValidVpa(vpa: string): boolean {
  return VPA_PATTERN.test(normaliseVpa(vpa));
}

/**
 * Why an id was refused, in words — so "invalid" never has to be guessed
 * at. Null when it's fine.
 */
export function vpaProblem(input: string): string | null {
  const vpa = normaliseVpa(input);
  if (vpa === "") return null;
  if (VPA_PATTERN.test(vpa)) return null;
  const at = vpa.split("@");
  if (at.length !== 2) return at.length < 2 ? "Missing the @bank part, e.g. name@ybl." : "More than one @.";
  const [local, handle] = at;
  const badLocal = local.match(/[^a-zA-Z0-9.\-_]/g);
  if (badLocal) return `Can't contain ${[...new Set(badLocal)].map((c) => `"${c}"`).join(" ")} before the @.`;
  const badHandle = handle.match(/[^a-zA-Z0-9.\-_]/g);
  if (badHandle) return `Can't contain ${[...new Set(badHandle)].map((c) => `"${c}"`).join(" ")} after the @.`;
  if (local.length < 2) return "Too short before the @.";
  if (!/^[a-zA-Z]/.test(handle)) return "The part after @ starts with a letter, like ybl or okaxis.";
  if (handle.length < 2) return "Too short after the @.";
  return "That doesn't look like a UPI id.";
}

export type UpiKind = "personal" | "merchant";

/**
 * Handles whose merchant ids take money only through the standee's own,
 * signed QR — a link with the amount is refused, and so is the id typed
 * into another app ("our banking partner is unable to process your
 * request"). Paytm's merchant handles are the known ones. For these, the
 * shop's QR is the way to pay, and the pay sheet says so.
 */
const QR_ONLY_HANDLES = /^(paytm|pty|ptys|ptyes|ptaxis|ptsbi|pthdfc)$/i;

export function handleOf(vpa: string): string {
  return normaliseVpa(vpa).split("@")[1] ?? "";
}

/** True when a merchant id on this handle is paid only by scanning its QR. */
export function isQrOnlyMerchant(vpa: string, kind: UpiKind): boolean {
  return kind === "merchant" && QR_ONLY_HANDLES.test(handleOf(vpa));
}

export interface UpiRequest {
  vpa: string;
  payeeName: string;
  /** Leave undefined for a personal payee — the payer types it. */
  amount?: number;
  /** Shown in the payer's app and in the operator's statement. */
  note: string;
  /**
   * Transaction reference. Letters and digits only — the spec says
   * alphanumeric and the strict apps mean it — and long enough that the
   * PSPs that want more than a short token don't refuse it. Anything else
   * is dropped before it goes in.
   */
  reference: string;
}

/**
 * Builds the `upi://pay` URI.
 *
 * Amount must be a plain decimal with at most two places; some UPI apps reject
 * a value with grouping separators or more precision, and the failure is a
 * silent "invalid request" rather than anything useful.
 *
 * No `mc` and no `mode`/`orgid`/`sign`, deliberately. Those mark a link as
 * a merchant-generated intent, and the apps then hold it to the merchant
 * rules — a signature from the merchant's PSP above all — which a link a
 * website built can't meet; PhonePe answers "our banking partner is unable
 * to process your request". Whether the payee is a merchant is a fact of
 * the id itself, known to the PSP, and a plain `pa`/`am` link to a
 * merchant id goes through on that alone.
 */
export function upiLink({ vpa, payeeName, amount, note, reference }: UpiRequest): string {
  const params = new URLSearchParams({ pa: vpa.trim(), pn: payeeName.trim() });
  if (amount !== undefined) params.set("am", amount.toFixed(2));
  params.set("cu", "INR");
  params.set("tn", note.replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50));
  params.set("tr", cleanReference(reference));
  // URLSearchParams encodes spaces as "+", which some UPI apps show literally.
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * A reference the strictest app accepts: alphanumeric, at most 35, and
 * padded with the Printify mark when the token alone is only a few
 * characters. `B66` becomes `PRINTIFYB66`; a raw id keeps its hex.
 */
export function cleanReference(reference: string): string {
  const bare = reference.replace(/[^A-Za-z0-9]/g, "");
  const withMark = bare.length < 8 ? `PRINTIFY${bare}` : bare;
  return withMark.slice(0, 35);
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
  const raw = text.replace(INVISIBLE, "");
  const m = /^upi:\/\/pay\?(.*)$/i.exec(raw);
  if (!m) return parseBharatQr(raw);
  const params = new URLSearchParams(m[1]);
  const vpa = (params.get("pa") ?? "").replace(INVISIBLE, "");
  if (!VPA_PATTERN.test(vpa)) return null;
  const mc = (params.get("mc") ?? "").trim();
  const merchantCode = /^\d{4}$/.test(mc) && mc !== "0000" ? mc : null;
  const name = (params.get("pn") ?? "").trim() || null;
  return { vpa, name, merchantCode, kind: merchantCode ? "merchant" : "personal" };
}

/**
 * A bank's standee is often a Bharat QR — EMVCo tag-length-value text
 * rather than a `upi://` link. The UPI id sits inside one of the
 * merchant-account tags (26–51) as its own sub-tag; the category code is
 * tag 52. Those are merchant QRs by construction, so a category code found
 * there decides it; without one, the id alone is still worth reading.
 */
function parseBharatQr(raw: string): ScannedUpi | null {
  // Tag 00, length 02, value 01: the payload format indicator every EMV QR opens with.
  if (!/^000201/.test(raw)) return null;
  const top = tlvEntries(raw);
  if (!top) return null;
  let vpa: string | null = null;
  for (const { tag, value } of top) {
    const n = Number(tag);
    if (n < 26 || n > 51) continue;
    const inner = tlvEntries(value) ?? [];
    const hit = inner.find((e) => VPA_PATTERN.test(e.value));
    if (hit) {
      vpa = hit.value;
      break;
    }
  }
  if (!vpa) return null;
  const mcc = top.find((e) => e.tag === "52")?.value ?? null;
  const merchantCode = mcc && /^\d{4}$/.test(mcc) && mcc !== "0000" ? mcc : null;
  const name = top.find((e) => e.tag === "59")?.value.trim() || null;
  return { vpa, name, merchantCode, kind: merchantCode ? "merchant" : "personal" };
}

/** Walks an EMVCo tag-length-value string. Null if the lengths don't add up. */
function tlvEntries(raw: string): { tag: string; value: string }[] | null {
  const out: { tag: string; value: string }[] = [];
  let i = 0;
  while (i < raw.length) {
    if (i + 4 > raw.length) return null;
    const tag = raw.slice(i, i + 2);
    const len = Number.parseInt(raw.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(tag) || !Number.isFinite(len) || i + 4 + len > raw.length) return null;
    out.push({ tag, value: raw.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}
