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
  "pages",
  "colour_pages",
  "config",
  "operator_id",
  "user_id",
  "token",
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

const done = fails === 0 ? "\nPASS - all checks passed" : `\nFAIL - ${fails} check(s) failed`;
console.log(done);
process.exit(fails === 0 ? 0 : 1);
