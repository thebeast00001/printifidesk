import { canInstall, platformFrom, type InstallState } from "../lib/install";
import { normalisePhone } from "../lib/phone";
import { summarisePages } from "../lib/pages";
import { buildSlots } from "../components/pickup-picker";
import { UPI_APPS, appLink, cleanReference, handleOf, isQrOnlyMerchant, isValidVpa, normaliseVpa, parseUpiQr, upiLink, vpaProblem } from "../lib/upi";
import { gatewayOrderId, vendorShare, vendorStatus, verifyWebhook, webhookSignature } from "../lib/server/cashfree";
import { shelfLabel, shelfSlots } from "../lib/orders";
import { pickBadges } from "../components/operator-picker";
import { paise, quoteOrder, rateCardOf, roundedTotal } from "../lib/pricing";
import type { Operator } from "../lib/orders";
import { secretMatches } from "../lib/server/secret";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { jwtMsRemaining } from "../lib/jwt";
import { clockLabel } from "../lib/utils";
import { deskPrefix, parseScan } from "../components/operator/scan-sheet";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { deskPath, hostsFrom, isSingleHost, onDesk, routeFor, sameOriginPath, surfaceFor } from "../lib/surface";
import { periodStart } from "../lib/platform";

let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(38)} got=${JSON.stringify(got)}`);
};

console.log("— phone normalisation (WhatsApp needs bare international digits) —");
check("plain 10-digit", normalisePhone("9876543210", "91"), "919876543210");
check("trunk zero stripped", normalisePhone("09876543210", "91"), "919876543210");
check("spaces and plus", normalisePhone("+91 98765 43210", "91"), "919876543210");
check("dashes", normalisePhone("098765-43210", "91"), "919876543210");
check("already international", normalisePhone("919876543210", "91"), "919876543210");
check("too short rejected", normalisePhone("12345", "91"), null);
check("empty rejected", normalisePhone("", "91"), null);
check("letters only rejected", normalisePhone("not a number", "91"), null);

console.log("\n— page ranges on the operator's job sheet —");
check("contiguous run", summarisePages([1, 2, 3]), "1–3");
check("split runs", summarisePages([1, 2, 3, 7, 8]), "1–3, 7–8");
check("singles", summarisePages([2, 5, 9]), "2, 5, 9");
check("unsorted input", summarisePages([8, 1, 3, 2, 7]), "1–3, 7–8");
check("duplicates collapse", summarisePages([3, 3, 4]), "3–4");
check("single page", summarisePages([4]), "4");
check("empty means all", summarisePages([]), "all");

console.log("\n— pickup slots (must respect hours, lead time and the future) —");
const op = {
  id: "o",
  name: "Test",
  campus: "c",
  is_open: true,
  status_note: null,
  status_changed_at: null,
  currency: "₹",
  bw_per_page: 1.5,
  colour_per_page: 8,
  duplex_discount: 0.08,
  staple_price: 5,
  bulk_threshold: 100,
  bulk_multiplier: 0.92,
  min_order: 0,
  paper_gsm: 80,
  pages_per_minute: 20,
  handling_minutes: 3,
  short_name: "Test",
  is_listed: true,
  opens_at: "09:00:00",
  closes_at: "17:00:00",
} as Operator;

// 10:00 on a fixed day, 40-page job → 2 min print + 3 min handling + 5 min buffer.
const now = new Date("2026-03-10T10:00:00");
const slots = buildSlots(op, 40, now);
const today = slots.filter((s) => s.day === "Today").map((s) => s.label);
console.log(`   today slots: ${today.slice(0, 4).join(", ")} … (${today.length} total)`);

check("no slot in the past", slots.every((s) => new Date(s.at) > now), true);
check(
  "all inside opening hours",
  slots.every((s) => {
    const h = new Date(s.at).getHours();
    return h >= 9 && h <= 17;
  }),
  true,
);
check(
  "first slot clears lead time",
  new Date(slots[0].at).getTime() - now.getTime() >= 10 * 60_000,
  true,
);
check("spans more than one day", new Set(slots.map((s) => s.day)).size > 1, true);

const inverted = buildSlots({ ...op, opens_at: "20:00:00", closes_at: "09:00:00" } as Operator, 10, now);
check("inverted hours yield none", inverted.length, 0);
check("null operator yields none", buildSlots(null, 10, now).length, 0);

// A job too big to finish before closing must not offer today's last slot.
const huge = buildSlots(op, 20_000, now);
check("huge job pushes past today", huge.every((s) => s.day !== "Today"), true);

console.log("\n— UPI links (a malformed one fails silently in the payer's app) —");
check("plain vpa", isValidVpa("ansh@okhdfcbank"), true);
check("dots and dashes", isValidVpa("ansh.tyagi-1@ybl"), true);
check("no handle rejected", isValidVpa("ansh"), false);
check("empty rejected", isValidVpa(""), false);
// A space can only be a paste artefact — ids never have one — so it goes rather than refuses.
check("inner space stripped, then valid", isValidVpa("ansh tyagi@ybl"), true);
check("double at rejected", isValidVpa("a@b@c"), false);

// Merchant ids, as the business apps actually issue them.
for (const id of [
  "Q123456789@ybl",
  "paytmqr2810050501011ab2c3d4e5@paytm",
  "gpay-11234567890@okbizaxis",
  "BHARATPE09912345678@yesbankltd",
  "merchant.name-01@icici",
  "9876543210@ibl",
  "shop_name@axl",
]) {
  check(`merchant id ${id.slice(0, 14)}… accepted`, isValidVpa(id), true);
}
// What a paste drags along: zero-width spaces, a BOM, a trailing newline, a soft hyphen.
check("zero-width space stripped", normaliseVpa("Q1234\u200B56789@ybl"), "Q123456789@ybl");
check("BOM and newline stripped", normaliseVpa("\uFEFFQ123456789@ybl\n"), "Q123456789@ybl");
check("soft hyphen stripped", normaliseVpa("shop\u00ADname@axl"), "shopname@axl");
check("inner space stripped", normaliseVpa("Q1234 56789@ybl"), "Q123456789@ybl");
check("a pasted upi:// text yields its pa", normaliseVpa("upi://pay?pa=Q123456789@ybl&pn=SHOP&mc=5111"), "Q123456789@ybl");
check("a pasted query fragment yields pa", normaliseVpa("pa=shop%40ybl&pn=x"), "shop@ybl");
check("valid after normalising", isValidVpa("\u200BQ123456789@ybl "), true);
// And the reason, when there is one.
check("no problem when fine", vpaProblem("Q123456789@ybl"), null);
check("no problem when empty", vpaProblem("   "), null);
check("missing handle explained", vpaProblem("Q123456789"), "Missing the @bank part, e.g. name@ybl.");
check("bad character named", vpaProblem("shop name#1@ybl"), 'Can\'t contain "#" before the @.');
check("handle must start with a letter", vpaProblem("shop@9ybl"), "The part after @ starts with a letter, like ybl or okaxis.");
// A bank's Bharat QR: EMVCo tags, the id inside, the category code in 52.
const tlv = (id: string, v: string) => id + String(v.length).padStart(2, "0") + v;
const bharat =
  tlv("00", "01") + tlv("01", "12") +
  tlv("26", tlv("00", "com.npci.upi.pay") + tlv("01", "shop@yesbank")) +
  tlv("52", "5812") + tlv("53", "356") + tlv("59", "SHOPX") + tlv("60", "BANGALORE");
check("Bharat QR → id", parseUpiQr(bharat)?.vpa, "shop@yesbank");
check("Bharat QR → merchant by tag 52", parseUpiQr(bharat)?.kind, "merchant");
check("Bharat QR → code", parseUpiQr(bharat)?.merchantCode, "5812");
// Paytm merchant ids are paid only by their own QR; others take a link.
check("handle read", handleOf(" paytm.s1oh2bk@pty "), "pty");
check("Paytm merchant is QR-only", isQrOnlyMerchant("paytm.s1oh2bk@pty", "merchant"), true);
check("@paytm merchant is QR-only", isQrOnlyMerchant("paytmqr2810050501011abcd@paytm", "merchant"), true);
check("a personal @paytm id is not", isQrOnlyMerchant("ansh@paytm", "personal"), false);
check("PhonePe Business is not QR-only", isQrOnlyMerchant("Q123456789@ybl", "merchant"), false);
check("GPay Business is not QR-only", isQrOnlyMerchant("gpay-11234567890@okbizaxis", "merchant"), false);

console.log("\n— paying through Printify (Cashfree) —");
const secret = "cf_test_secret";
const raw = '{"data":{"order":{"order_id":"PFabc","order_amount":14.00},"payment":{"cf_payment_id":1,"payment_status":"SUCCESS","payment_amount":14.00}},"type":"PAYMENT_SUCCESS_WEBHOOK"}';
const ts = "1617695238078";
const sig = webhookSignature(ts, raw, secret);
check("a genuine signature verifies", verifyWebhook(raw, ts, sig, secret), true);
check("a reserialised body does not", verifyWebhook(JSON.stringify(JSON.parse(raw)), ts, sig, secret), false);
check("a wrong secret does not", verifyWebhook(raw, ts, sig, "other"), false);
check("a missing header does not", verifyWebhook(raw, null, sig, secret), false);
check("a tampered timestamp does not", verifyWebhook(raw, "1617695238079", sig, secret), false);
check("gateway order id from a uuid", gatewayOrderId("0b7a2f6e-4c3d-4e5f-8a9b-0c1d2e3f4a5b"), "PF0b7a2f6e4c3d4e5f8a9b0c1d2e3f4a5b");
check("a second attempt is suffixed", gatewayOrderId("0b7a2f6e-4c3d-4e5f-8a9b-0c1d2e3f4a5b", 2), "PF0b7a2f6e4c3d4e5f8a9b0c1d2e3f4a5b-2");
check("gateway order id fits Cashfree", /^[A-Za-z0-9_-]{3,45}$/.test(gatewayOrderId("0b7a2f6e-4c3d-4e5f-8a9b-0c1d2e3f4a5b", 3)), true);
check("vendor share is the bill less the fee", vendorShare(14, 0.42), 13.58);
check("vendor share keeps the rounding", vendorShare(14, 0.41), 13.59);
check("vendor share never negative", vendorShare(1, 5), 0);
check("ACTIVE → active", vendorStatus("ACTIVE"), "active");
check("IN_BENE_CREATION → pending", vendorStatus("IN_BENE_CREATION"), "pending");
check("BLOCKED → blocked", vendorStatus("BLOCKED"), "blocked");
check("unknown → pending", vendorStatus(undefined), "pending");

const link = upiLink({
  vpa: "ansh@okhdfcbank",
  payeeName: "Printify Block C",
  amount: 55,
  note: "Printify A47",
  reference: "A47",
});
check("scheme", link.startsWith("upi://pay?"), true);
check("amount has 2 decimals", /[?&]am=55\.00(&|$)/.test(link), true);
check("currency set", /[?&]cu=INR(&|$)/.test(link), true);
check("reference carried, padded to a real length", /[?&]tr=PRINTIFYA47(&|$)/.test(link), true);
// "+" for a space is shown literally by some UPI apps.
check("no plus-encoded spaces", link.includes("+"), false);
check("space is %20", link.includes("Printify%20Block%20C"), true);

const rounded = upiLink({
  vpa: "a@b", payeeName: "x", amount: 12.5, note: "n", reference: "r",
});
check("half rupee formats", /[?&]am=12\.50(&|$)/.test(rounded), true);

// A personal payee: the apps refuse a third-party link with the amount in
// it, so the link carries none and the payer types it.
const personal = upiLink({ vpa: "ansh@ybl", payeeName: "Ansh", note: "Printify B12", reference: "B12" });
check("no amount → no am=", /[?&]am=/.test(personal), false);
check("no amount still carries the reference", /[?&]tr=PRINTIFYB12(&|$)/.test(personal), true);
// Nothing that marks the link as a merchant-generated intent: the apps then
// demand the merchant PSP's signature, and PhonePe refuses without it.
const toMerchant = upiLink({ vpa: "Q123456789@ybl", payeeName: "Shop", amount: 10, note: "Printify B66", reference: "B66abcd1234" });
check("no mc in the link", /[?&](mc|mode|orgid|sign)=/.test(toMerchant), false);
check("reference is alphanumeric", /[?&]tr=([A-Za-z0-9]+)(&|$)/.test(toMerchant), true);
check("a short token is padded", cleanReference("B66"), "PRINTIFYB66");
check("a long reference keeps itself", cleanReference("B66abcd1234"), "B66abcd1234");
check("punctuation dropped from the reference", cleanReference("PF-1234-ABCD"), "PF1234ABCD");
check("reference capped at 35", cleanReference("A".repeat(50)).length, 35);
check("note keeps letters, digits, spaces", /[?&]tn=Printify%20B66(&|$)/.test(toMerchant), true);
const oddNote = upiLink({ vpa: "a@b", payeeName: "x", note: "Printify #B66 — colour!", reference: "r" });
check("note punctuation becomes spaces", /[?&]tn=Printify%20B66%20colour(&|$)/.test(oddNote), true);
// Picking an app by name: the same query behind each app's own scheme.
const req = { vpa: "Q533273833@ybl", payeeName: "Shop", amount: 6, note: "Printify A03", reference: "A03abcd1234" };
const gpay = UPI_APPS.find((a) => a.id === "gpay")!;
const phonepe = UPI_APPS.find((a) => a.id === "phonepe")!;
const paytm = UPI_APPS.find((a) => a.id === "paytm")!;
check("Google Pay on Android", appLink(gpay, req, "android").startsWith("tez://upi/pay?"), true);
check("Google Pay on iOS", appLink(gpay, req, "ios").startsWith("gpay://upi/pay?"), true);
check("PhonePe scheme", appLink(phonepe, req).startsWith("phonepe://pay?"), true);
check("Paytm scheme", appLink(paytm, req).startsWith("paytmmp://pay?"), true);
check("the query is the same as the plain link", appLink(gpay, req).split("?")[1], upiLink(req).split("?")[1]);
check("PhonePe is marked as refusing", phonepe.refuses, true);

// Reading the shop's own QR: mc decides the kind.
const business = parseUpiQr("upi://pay?pa=Q123456789@ybl&pn=SHARMA%20XEROX&mc=5111&mode=02&purpose=00");
check("business QR → merchant", business?.kind, "merchant");
check("business QR → code", business?.merchantCode, "5111");
check("business QR → name decoded", business?.name, "SHARMA XEROX");
check("GPay personal QR (mc=0000) → personal", parseUpiQr("upi://pay?pa=ansh@okaxis&pn=Ansh&mc=0000&mode=02")?.kind, "personal");
check("plain personal QR → personal", parseUpiQr("upi://pay?pa=ansh@ybl&pn=Ansh")?.kind, "personal");
check("not a UPI QR → null", parseUpiQr("printify:order:A03:7F3A9C21"), null);
check("UPI QR with a bad id → null", parseUpiQr("upi://pay?pa=nope&pn=x"), null);

console.log("\n— rounding to the rupee —");
const plain = rateCardOf({ bw_per_page: "1.35", colour_per_page: "7.75", min_order: "0", platform_fee_percent: "3.25" });
const rounds = rateCardOf({ bw_per_page: "1.35", colour_per_page: "7.75", min_order: "0", platform_fee_percent: "3.25", round_to_rupee: true });
const rq = quoteOrder([{ pages: 7, colourPages: 2, config: { colour: "smart", sides: "single", binding: "none", copies: 1 } }], rounds);
const pq = quoteOrder([{ pages: 7, colourPages: 2, config: { colour: "smart", sides: "single", binding: "none", copies: 1 } }], plain);
check("unrounded total has paise", Number.isInteger(pq.total), false);
check("rounded total is whole", Number.isInteger(rq.total), true);
check("rounding is the difference", rq.rounding, paise(rq.total - pq.total));
check("rounding never a whole rupee", rq.rounding < 1 && rq.rounding >= 0, true);
check("fee unchanged by rounding", rq.platformFee, pq.platformFee);
check("lines unchanged by rounding", rq.lines[0].price, pq.lines[0].price);
check("no rounding when off", pq.rounding, 0);
check("a whole total stays put", roundedTotal(14, rounds), { total: 14, rounding: 0 });
check("13.91 lifts to 14", roundedTotal(13.91, rounds), { total: 14, rounding: 0.09 });
check("13.005 → paise first, then the rupee", roundedTotal(13.005, rounds), { total: 14, rounding: 0.99 });
check("off: 13.91 stays", roundedTotal(13.91, plain), { total: 13.91, rounding: 0 });

console.log("\n— the write guard (RLS grants rows, never columns) —");

// The guard names every column a student may not change. Adding a column to
// `orders` without adding it here is how a student ends up able to rewrite
// their own total or fake a refund — it has happened twice already, so this
// asserts it rather than trusting a review.
const migrationsDir = join(__dirname, "..", "supabase", "migrations");
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

// The last definition wins in Postgres, so only the last one matters here too.
const guardSource = migrations
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .filter((sql) => sql.includes("function public.guard_order_update()"))
  .pop();

check("guard exists", typeof guardSource === "string", true);

const guard = guardSource ?? "";
const body = guard.slice(guard.lastIndexOf("function public.guard_order_update()"));

for (const column of [
  "total",
  "full_colour_total",
  "platform_fee",
  "pages",
  "colour_pages",
  "config",
  "operator_id",
  "user_id",
  "token",
  "handover_code",
  "rate_card",
  "is_priority",
  "operator_note",
  "payment_taken_at",
  "collected_at",
  "refunded_at",
  "refund_amount",
  "refund_note",
  // 0028: what the desk saw arrive, what rounding added, when the rest was taken.
  "rounding",
  "payment_received",
  "shortfall_cleared_at",
  // 0030: where the packet is — the desk's to set, never the student's.
  "shelf_slot",
]) {
  check(`pins ${column}`, new RegExp(`new\\.${column}\\s*:=\\s*old\\.${column}`).test(body), true);
}

// The two the student is *supposed* to write, or paying breaks.
check("leaves payment_claimed_at", /new\.payment_claimed_at\s*:=\s*old\./.test(body), false);
check("reference pinned only after check", body.includes("old.payment_taken_at is not null"), true);
// The student's amount is a claim like the reference: theirs until the desk
// confirms, frozen after — so it's pinned inside that same block, not above it.
const freezeBlock = body.slice(body.indexOf("old.payment_taken_at is not null"));
check("claimed amount frozen only after confirmation", /new\.payment_claimed_amount\s*:=\s*old\.payment_claimed_amount/.test(freezeBlock), true);
check("claimed amount free before it", /new\.payment_claimed_amount\s*:=\s*old\./.test(body.slice(0, body.indexOf("old.payment_taken_at is not null"))), false);

console.log("\n— migration hygiene —");
const numbers = migrations.map((f) => f.slice(0, 4));
check("no duplicate prefixes", new Set(numbers).size, numbers.length);
check(
  "numbered without gaps",
  numbers.every((n, i) => Number(n) === i + 1),
  true,
);

console.log("\n— the maintenance secret (constant-time, so length can't leak) —");
check("exact match accepted", secretMatches("s3cr3t-value", "s3cr3t-value"), true);
check("wrong value rejected", secretMatches("s3cr3t-valuf", "s3cr3t-value"), false);
check("prefix rejected", secretMatches("s3cr3t", "s3cr3t-value"), false);
check("longer rejected", secretMatches("s3cr3t-value-and-more", "s3cr3t-value"), false);
check("empty rejected", secretMatches("", "s3cr3t-value"), false);
check("missing header rejected", secretMatches(null, "s3cr3t-value"), false);
check("unset secret rejects everything", secretMatches("anything", ""), false);

console.log("\n— clock labels (the operator typed a time of day; the student reads one) —");
check("evening", clockLabel("20:00:00"), "8 PM");
check("morning with minutes", clockLabel("09:30:00"), "9:30 AM");
check("noon", clockLabel("12:00:00"), "12 PM");
check("midnight", clockLabel("00:00:00"), "12 AM");
check("no seconds", clockLabel("17:45"), "5:45 PM");
check("null stays null", clockLabel(null), null);
check("garbage stays null", clockLabel("soon"), null);

console.log("\n— handover scans (a code is proof; a bare token is only a lookup) —");
check(
  "student QR carries code and desk",
  parseScan("printify:order:A03:7F3A9C21:5E9A1C2B"),
  { token: "A03", code: "7F3A9C21", desk: "5E9A1C2B" },
);
check("older QR without a desk still parses", parseScan("printify:order:A03:7F3A9C21"), { token: "A03", code: "7F3A9C21", desk: null });
check("slip QR has no code", parseScan("printify:order:A03"), { token: "A03", code: null, desk: null });
check("typed lowercase token", parseScan(" b12 "), { token: "B12", code: null, desk: null });
check("desk prefix from a uuid", deskPrefix("5e9a1c2b-1234-4abc-9def-000000000000"), "5E9A1C2B");
check("code is upper-cased", parseScan("printify:order:a03:7f3a9c21")?.code, "7F3A9C21");
check("a short code is not a code", parseScan("printify:order:A03:7F3")?.code ?? "rejected", "rejected");
check("garbage rejected", parseScan("https://evil.example/A03"), null);
check("a bare number is not a token", parseScan("12345"), null);

console.log("\n— the QR round trip (what the island draws, the desk's decoder must read) —");
// Rasterise with the same `qrcode` library the island uses, then decode the
// pixels with jsQR — the path the scanner takes wherever the browser has no
// native detector, which on Windows Chrome is "always, despite appearances".
{
  const payload = "printify:order:A03:7F3A9C21:5E9A1C2B";
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const modules = qr.modules;
  const scale = 6;
  const quiet = 4 * scale;
  const size = modules.size * scale + quiet * 2;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (!modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((quiet + y * scale + dy) * size + (quiet + x * scale + dx)) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
        }
      }
    }
  }
  const read = jsQR(rgba, size, size, { inversionAttempts: "attemptBoth" });
  check("decodes what the island draws", read?.data, payload);
  check("and the parser reads it back", parseScan(read?.data ?? ""), {
    token: "A03",
    code: "7F3A9C21",
    desk: "5E9A1C2B",
  });
  // Dark-mode phones show the island's code light-on-dark; inversion must hold.
  const inverted = rgba.map((v, i) => (i % 4 === 3 ? v : 255 - v));
  check("reads an inverted (dark mode) code", jsQR(inverted, size, size, { inversionAttempts: "attemptBoth" })?.data, payload);
}

console.log("\n— token expiry (the realtime socket must refresh before it lapses) —");
// A JWT with exp = now + 45s, built the way Clerk builds them: three
// base64url segments. The signature is nonsense on purpose — nothing here
// verifies it, and a helper that needed a real one would be testing the
// wrong thing.
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const at = 1_800_000_000_000; // a fixed "now"
const tokenExpiring = (secs: number) =>
  `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: "user_x", exp: at / 1000 + secs }))}.sig`;
check("45s left reads as 45000", jwtMsRemaining(tokenExpiring(45), at), 45_000);
check("expired reads negative", (jwtMsRemaining(tokenExpiring(-5), at) ?? 0) < 0, true);
check("no exp reads unknown", jwtMsRemaining(`${b64url("{}")}.${b64url('{"sub":"x"}')}.s`, at), null);
check("garbage reads unknown", jwtMsRemaining("not-a-token", at), null);
check("two segments reads unknown", jwtMsRemaining("a.b", at), null);

console.log("\n— two sites: which host serves what —");
const two = hostsFrom({ desk: "desk.printifi.store" });
const one = hostsFrom({});
check("student host derived from desk.", two.student, "printifi.store");
check("scheme and path stripped", hostsFrom({ desk: "https://desk.printifi.store/x" }).desk, "desk.printifi.store");
check("no desk host → single", isSingleHost(one), true);
check("desk host is the desk", surfaceFor("desk.printifi.store", two), "desk");
check("student host is the student", surfaceFor("printifi.store", two), "student");
check("desk.localhost is the desk, even single", surfaceFor("desk.localhost:3000", one), "desk");
check("localhost is the student", surfaceFor("localhost:3000", one), "student");
check("host case-insensitive", surfaceFor("DESK.Printifi.store", two), "desk");
check("a pinned deployment is the desk anywhere", surfaceFor("printify-desk-abc.vercel.app", one, "desk"), "desk");
check("a pinned deployment is the student anywhere", surfaceFor("desk.printifi.store", two, "student"), "student");
check("an unknown pin is ignored", surfaceFor("localhost:3000", one, "banana"), "student");

// desk site
check("desk / → queue", routeFor("desk", "/", two), { kind: "rewrite", to: "/operator" });
check("desk /takings → face", routeFor("desk", "/takings", two), { kind: "rewrite", to: "/operator/takings" });
check("desk /settings is the desk's", routeFor("desk", "/settings", two), { kind: "rewrite", to: "/operator/settings" });
check("desk /operator/x → short", routeFor("desk", "/operator/takings", two), { kind: "redirect", to: "/takings" });
check("desk /operator → /", routeFor("desk", "/operator", two), { kind: "redirect", to: "/" });
check("desk /join passes", routeFor("desk", "/join/XK7P2Q4M", two), { kind: "pass" });
check("desk /admin passes", routeFor("desk", "/admin", two), { kind: "pass" });
check("desk /sign-in passes", routeFor("desk", "/sign-in", two), { kind: "pass" });
check("desk /api passes", routeFor("desk", "/api/desk", two), { kind: "pass" });
check("desk /privacy passes", routeFor("desk", "/privacy", two), { kind: "pass" });

/* ---------- installing: who gets offered what ---------- */
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
check("iPhone is ios", platformFrom(IPHONE, 5, "iPhone"), "ios");
check("iPad posing as a Mac is ios", platformFrom(IPAD_AS_MAC, 5, "MacIntel"), "ios");
check("a real Mac is desktop", platformFrom(IPAD_AS_MAC, 0, "MacIntel"), "desktop");
check("Android is android", platformFrom(ANDROID, 5, "Linux armv8l"), "android");
check("Windows is desktop", platformFrom(WINDOWS, 0, "Win32"), "desktop");
const base = { installed: false, prompt: null, platform: "desktop" as const, dismissed: false, ready: true };
const fakePrompt = {} as unknown as NonNullable<InstallState["prompt"]>;
check("nothing offered before the first client read", canInstall({ ...base, ready: false, prompt: fakePrompt }), false);
check("nothing offered once installed", canInstall({ ...base, installed: true, prompt: fakePrompt }), false);
check("Chrome's prompt is offered", canInstall({ ...base, prompt: fakePrompt }), true);
check("iOS is offered the steps", canInstall({ ...base, platform: "ios" }), true);
check("desktop Firefox is offered nothing", canInstall(base), false);
check("Android that turned the dialog down still gets the menu route", canInstall({ ...base, platform: "android", dismissed: true }), true);
check("desktop that turned it down gets nothing", canInstall({ ...base, dismissed: true }), false);
check("student /terms passes", routeFor("student", "/terms", two), { kind: "pass" });
check("desk /board passes", routeFor("desk", "/board", two), { kind: "pass" });
check("student /board passes", routeFor("student", "/board", two), { kind: "pass" });

console.log("\n— the shelf and the badges —");
check("A1 is row 1 col 1", shelfLabel(1, 1), "A1");
check("H20 is the last slot", shelfLabel(8, 20), "H20");
check("2×3 shelf, filled row by row", shelfSlots(2, 3), ["A1", "A2", "A3", "B1", "B2", "B3"]);
check("no rows, no shelf", shelfSlots(0, 9), []);
check("rows capped at 8", shelfSlots(12, 1).length, 8);
const desks = [
  { id: "a", open: true, total: 40, wait: 12 },
  { id: "b", open: true, total: 36, wait: 5 },
  { id: "c", open: false, total: 20, wait: 1 },
];
check("cheapest open desk", pickBadges(desks).cheapest, "b");
check("fastest open desk", pickBadges(desks).fastest, "b");
check("a closed desk wins nothing", pickBadges(desks).cheapest === "c", false);
check("one desk, no badges", pickBadges([desks[0]]), { cheapest: null, fastest: null });
check("a tie on price earns no badge", pickBadges([{ ...desks[0], total: 36 }, desks[1]]).cheapest, null);
check("a tie on wait earns no badge", pickBadges([{ ...desks[0], wait: 5 }, desks[1]]).fastest, null);
check("unknown waits don't compete", pickBadges([{ ...desks[0], wait: null }, desks[1]]).fastest, null);
check("desk /orders → student site", routeFor("desk", "/orders", two), { kind: "redirect", to: "/orders", host: "student" });
check("desk /orders, single → the queue", routeFor("desk", "/orders", one), { kind: "redirect", to: "/" });

// student site
check("student / passes", routeFor("student", "/", two), { kind: "pass" });
check("student /orders passes", routeFor("student", "/orders", two), { kind: "pass" });
check("student /operator → desk /", routeFor("student", "/operator", two), { kind: "redirect", to: "/", host: "desk" });
check("student /operator/settings → desk", routeFor("student", "/operator/settings", two), { kind: "redirect", to: "/settings", host: "desk" });
check("student /join → desk, path kept", routeFor("student", "/join/XK7P2Q4M", two), { kind: "redirect", to: "/join/XK7P2Q4M", host: "desk" });
check("student /admin → desk", routeFor("student", "/admin", two), { kind: "redirect", to: "/admin", host: "desk" });
check("single host: nothing moves", routeFor("student", "/operator/settings", one), { kind: "pass" });

// links and chrome
check("deskPath short on desk", deskPath("desk", "/operator/takings"), "/takings");
check("deskPath root on desk", deskPath("desk", "/operator"), "/");
check("deskPath untouched elsewhere", deskPath("student", "/operator/takings"), "/operator/takings");
check("deskPath leaves /join alone", deskPath("desk", "/join"), "/join");
check("onDesk: desk site always", onDesk("desk", "/"), true);
check("onDesk: /operator on one host", onDesk("student", "/operator/settings"), true);
check("onDesk: student home", onDesk("student", "/"), false);
check("sameOriginPath keeps a path", sameOriginPath("/orders?x=1", "/"), "/orders?x=1");
check("sameOriginPath refuses a host", sameOriginPath("https://evil.example/", "/"), "/");
check("sameOriginPath refuses //", sameOriginPath("//evil.example", "/"), "/");
check("sameOriginPath refuses /\\", sameOriginPath("/\\evil.example", "/"), "/");
check("sameOriginPath fallback on null", sameOriginPath(null, "/orders"), "/orders");
check("absolute, same origin → path", sameOriginPath("http://localhost:3000/orders?x=1", "/", "http://localhost:3000"), "/orders?x=1");
check("absolute, same origin, bare → /", sameOriginPath("http://localhost:3000", "/", "http://localhost:3000"), "/");
check("absolute, other origin → fallback", sameOriginPath("http://localhost:3000.evil.com/x", "/", "http://localhost:3000"), "/");
check("absolute, origin unknown → fallback", sameOriginPath("http://localhost:3000/orders", "/"), "/");

console.log("\n— fee windows (calendar, in the viewer's own time) —");
// Saturday 12 September 2026, 15:42 local.
const sat = new Date(2026, 8, 12, 15, 42, 0);
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
check("today starts at local midnight", iso(periodStart("today", sat)), "2026-09-12 0:00");
check("this week starts on Monday", iso(periodStart("week", sat)), "2026-09-07 0:00");
check("this month starts on the 1st", iso(periodStart("month", sat)), "2026-09-01 0:00");
// A Monday is its own week start; a Sunday belongs to the week that began six days earlier.
check("Monday is the week start", iso(periodStart("week", new Date(2026, 8, 7, 9, 0, 0))), "2026-09-07 0:00");
check("Sunday looks back six days", iso(periodStart("week", new Date(2026, 8, 13, 9, 0, 0))), "2026-09-07 0:00");

const done = fails === 0 ? "\nPASS - all checks passed" : `\nFAIL - ${fails} check(s) failed`;
console.log(done);
process.exit(fails === 0 ? 0 : 1);
