import { canInstall, platformFrom, type InstallState } from "../lib/install";
import { normalisePhone } from "../lib/phone";
import { summarisePages } from "../lib/pages";
import { buildSlots } from "../components/pickup-picker";
import { isValidVpa, upiLink } from "../lib/upi";
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
check("spaces rejected", isValidVpa("ansh tyagi@ybl"), false);
check("double at rejected", isValidVpa("a@b@c"), false);

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
check("reference carried", /[?&]tr=A47(&|$)/.test(link), true);
// "+" for a space is shown literally by some UPI apps.
check("no plus-encoded spaces", link.includes("+"), false);
check("space is %20", link.includes("Printify%20Block%20C"), true);

const rounded = upiLink({
  vpa: "a@b", payeeName: "x", amount: 12.5, note: "n", reference: "r",
});
check("half rupee formats", /[?&]am=12\.50(&|$)/.test(rounded), true);

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
]) {
  check(`pins ${column}`, new RegExp(`new\\.${column}\\s*:=\\s*old\\.${column}`).test(body), true);
}

// The two the student is *supposed* to write, or paying breaks.
check("leaves payment_claimed_at", /new\.payment_claimed_at\s*:=\s*old\./.test(body), false);
check("reference pinned only after check", body.includes("old.payment_taken_at is not null"), true);

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
