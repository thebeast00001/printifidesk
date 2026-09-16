/**
 * Runs the RLS policies against the real project, as real roles.
 *
 * `check:sql` proves every function and trigger in PGlite — as superuser,
 * which bypasses row-level security. So until this ran, no policy in this
 * repository had ever been *executed* against a non-superuser role. This
 * script closes that: it mints session tokens for two of your own accounts
 * through Clerk's Backend API (no passwords, sixty-second tokens), then
 * tries to cross them — read the other's orders, another desk's staff,
 * write the ledger, change the fee — and reports what the database allowed.
 *
 *   npm run check:rls -- --student you@gmail.com --desk owner@example.com
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and
 * CLERK_SECRET_KEY from .env.local. With the desk on its own Clerk
 * application, pass its secret with --desk-secret <sk_...> (or point
 * --desk-env at that checkout's .env.local). Each account needs an active
 * session — sign in once in a browser first.
 *
 * What it can't do: create anything. Every probe is a read or a write the
 * policies must refuse; nothing here should change a row, and the report
 * says so if something did.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/* ---------- arguments and environment ---------- */

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function envFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

const here = join(__dirname, "..");
const env = { ...envFile(join(here, ".env.local")), ...process.env } as Record<string, string | undefined>;
const deskEnv = arg("desk-env") ? envFile(arg("desk-env")!) : {};

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const STUDENT_SECRET = env.CLERK_SECRET_KEY;
const DESK_SECRET = arg("desk-secret") ?? deskEnv.CLERK_SECRET_KEY ?? STUDENT_SECRET;
const studentEmail = arg("student");
const deskEmail = arg("desk");

if (!SUPABASE_URL || !ANON_KEY || !STUDENT_SECRET || !studentEmail) {
  console.error(
    "usage: npm run check:rls -- --student <email> [--desk <email>] [--desk-secret sk_… | --desk-env ../printifydesk/.env.local]\n" +
      "needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and CLERK_SECRET_KEY in .env.local",
  );
  process.exit(2);
}

/* ---------- Clerk: a token for an account that is already signed in ---------- */

async function clerk<T>(secret: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Clerk ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function tokenFor(secret: string, email: string): Promise<{ userId: string; jwt: string }> {
  const users = await clerk<{ id: string }[]>(secret, `/users?email_address=${encodeURIComponent(email)}&limit=1`);
  if (!users[0]) throw new Error(`no Clerk user with email ${email} on that application`);
  const sessions = await clerk<{ id: string; status: string }[]>(
    secret,
    `/sessions?user_id=${users[0].id}&status=active&limit=1`,
  );
  if (!sessions[0]) throw new Error(`${email} has no active session — sign in once in a browser, then rerun`);
  const { jwt } = await clerk<{ jwt: string }>(secret, `/sessions/${sessions[0].id}/tokens`, {
    method: "POST",
    body: JSON.stringify({ expires_in_seconds: 120 }),
  });
  return { userId: users[0].id, jwt };
}

function asRole(jwt: string | null): SupabaseClient {
  return createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { persistSession: false },
    ...(jwt ? { accessToken: async () => jwt } : {}),
  });
}

/* ---------- the probes ---------- */

let fails = 0;
let probes = 0;
let skipped = 0;
const report = (name: string, ok: boolean, detail: string) => {
  probes++;
  if (!ok) fails++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(52)} ${detail}`);
};
const skip = (name: string, why: string) => {
  skipped++;
  console.log(`--   ${name.padEnd(52)} skipped: ${why}`);
};
/** A function the project hasn't got yet is a migration to run, not a hole. */
const missing = (message: string | undefined) => /could not find the function|does not exist/i.test(message ?? "");

async function main() {
  const student = await tokenFor(STUDENT_SECRET!, studentEmail!);
  // Without a second account, the same one plays the desk: its staff rows,
  // if any, drive the desk-side probes; the cross-account ones are skipped.
  const desk = deskEmail ? await tokenFor(DESK_SECRET!, deskEmail) : student;
  const S = asRole(student.jwt);
  const D = asRole(desk.jwt);
  const A = asRole(null);
  console.log(`student ${studentEmail} (${student.userId.slice(0, 12)}…), desk ${deskEmail ?? "(same account)"} (${desk.userId.slice(0, 12)}…)`);

  // An admin is allowed the admin things; those probes mean nothing on an
  // admin account, so they're skipped rather than reported as holes.
  const { data: studentIsAdmin } = await S.rpc("is_admin");
  const { data: deskIsAdmin } = await D.rpc("is_admin");
  if (studentIsAdmin) console.log("(the student account is the admin — admin-only refusals are skipped for it)");
  if (deskIsAdmin && deskEmail) console.log("(the desk account is the admin — admin-only refusals are skipped for it)");
  console.log("");

  // What the desk account is staff of, by its own token — the baseline.
  const { data: deskStaff, error: e0 } = await D.from("staff").select("operator_id").eq("user_id", desk.userId);
  const deskIds = (deskStaff ?? []).map((r) => r.operator_id as string);
  report("desk account reads its own staff rows", !e0, e0 ? e0.message : `${deskIds.length} desk(s)`);
  if (deskIds.length === 0) {
    console.log("     (the desk account isn't on a desk yet; the desk-side probes will be thin)");
  }

  console.log("\n— anonymous —");
  for (const table of ["orders", "profiles", "staff", "documents", "platform_settlements", "staff_pins", "push_subscriptions"]) {
    const { data, error } = await A.from(table).select("*").limit(5);
    report(`anon reads nothing from ${table}`, !error && (data ?? []).length === 0, error ? error.message : `${(data ?? []).length} rows`);
  }
  const { data: ps } = await A.from("platform_settings").select("fee_percent").limit(1);
  report("anon can read the fee rate (a quote needs it)", (ps ?? []).length === 1, `${(ps ?? []).length} row`);

  // 0036: the grants. "permission denied" is the answer wanted; "could not
  // find the function" means 0036 isn't on the project yet.
  const denied = (message: string | undefined) => /permission denied/i.test(message ?? "");
  const seq = await A.from("token_sequence").select("*").limit(1);
  report("anon can't read token_sequence", Boolean(seq.error) && denied(seq.error?.message), seq.error ? seq.error.message.slice(0, 60) : `${(seq.data ?? []).length} rows READ`);
  const claim = await A.rpc("claim_notifications", { p_limit: 1 });
  if (missing(claim.error?.message)) skip("anon can't claim the notification queue", "claim_notifications isn't on the project — run 0006");
  else report("anon can't claim the notification queue", Boolean(claim.error) && denied(claim.error?.message), claim.error ? claim.error.message.slice(0, 60) : `${(claim.data ?? []).length} rows CLAIMED`);
  const qs = await A.rpc("queue_status", { p_order: "00000000-0000-0000-0000-000000000000" });
  report("anon can't call queue_status (0036)", Boolean(qs.error) && denied(qs.error?.message), qs.error ? qs.error.message.slice(0, 60) : "answered");
  const srv = await A.rpc("is_server");
  if (missing(srv.error?.message)) report("0036 is on the project", false, "is_server() isn't there — run 0036");
  else report("0036 is on the project", denied(srv.error?.message), srv.error ? srv.error.message.slice(0, 60) : "callable (should be permission denied)");

  console.log("\n— the student —");
  const { data: sOrders } = await S.from("orders").select("id, user_id").limit(200);
  const foreign = (sOrders ?? []).filter((o) => o.user_id !== student.userId);
  report("student sees only their own orders", foreign.length === 0, `${(sOrders ?? []).length} own, ${foreign.length} foreign`);
  const { data: sStaff } = await S.from("staff").select("*").limit(50);
  const sStaffForeign = (sStaff ?? []).filter((r) => r.user_id !== student.userId);
  report("student sees no one else's staff rows", sStaffForeign.length === 0, `${sStaffForeign.length} foreign`);
  const { data: sProfiles } = await S.from("profiles").select("id").limit(50);
  const sProfForeign = (sProfiles ?? []).filter((p) => p.id !== student.userId);
  report("student sees no other profile (unless a desk serving them)", sProfForeign.length === 0, `${sProfForeign.length} other`);
  const { data: sDocs } = await S.from("documents").select("user_id").limit(200);
  report("student sees only their own documents", (sDocs ?? []).every((d) => d.user_id === student.userId), `${(sDocs ?? []).length} rows`);
  for (const table of ["staff_pins", "platform_settlements", "desk_devices", "stock_log", "desk_closeouts", "invite_attempts"]) {
    const { data } = await S.from(table).select("*").limit(5);
    report(`student reads nothing from ${table}`, (data ?? []).length === 0, `${(data ?? []).length} rows`);
  }

  // Writes the policies must refuse. None of these should change a row.
  const own = (sOrders ?? []).find((o) => o.user_id === student.userId);
  if (own) {
    const { data: before } = await S.from("orders").select("total, platform_fee").eq("id", own.id).single();
    await S.from("orders").update({ total: 1, platform_fee: 0 }).eq("id", own.id);
    const { data: after } = await S.from("orders").select("total, platform_fee").eq("id", own.id).single();
    report(
      "student can't rewrite their own total or fee (guard)",
      String(after?.total) === String(before?.total) && String(after?.platform_fee) === String(before?.platform_fee),
      `total ${before?.total} → ${after?.total}`,
    );
  } else {
    console.log("     (no order on the student account, so the guard probe was skipped)");
  }
  const ins = await S.from("platform_settlements").insert({ operator_id: deskIds[0] ?? "00000000-0000-0000-0000-000000000000", amount: 1, recorded_by: "x" });
  report("student can't insert a settlement", Boolean(ins.error), ins.error ? ins.error.message.slice(0, 60) : "INSERTED");
  if (studentIsAdmin) {
    skip("student can't change the platform fee", "this account is the admin");
    skip("student gets nothing from admin_fee_desks", "this account is the admin");
  } else {
    const fee = await S.rpc("set_platform_fee", { p_percent: 20, p_min: 0, p_vpa: null, p_name: null, p_grace_days: 15 });
    if (missing(fee.error?.message)) skip("student can't change the platform fee", "set_platform_fee(…, p_grace_days) isn't on the project — run 0025");
    else report("student can't change the platform fee", Boolean(fee.error) && /admin/i.test(fee.error?.message ?? ""), fee.error ? fee.error.message.slice(0, 60) : "CHANGED");
    const adminList = await S.rpc("admin_fee_desks", { p_from: new Date(0).toISOString(), p_to: new Date().toISOString() });
    if (missing(adminList.error?.message)) skip("student gets nothing from admin_fee_desks", "admin_fee_desks isn't on the project — run 0022");
    else report("student gets nothing from admin_fee_desks", (adminList.data ?? []).length === 0, `${(adminList.data ?? []).length} rows`);
  }
  const staffIns = await S.from("staff").insert({ user_id: student.userId, operator_id: deskIds[0] ?? "00000000-0000-0000-0000-000000000000" });
  report("student can't insert themselves as staff", Boolean(staffIns.error), staffIns.error ? staffIns.error.message.slice(0, 60) : "INSERTED");
  const sClaim = await S.rpc("claim_notifications", { p_limit: 1 });
  if (!missing(sClaim.error?.message)) report("student can't claim the notification queue", Boolean(sClaim.error) && denied(sClaim.error?.message), sClaim.error ? sClaim.error.message.slice(0, 60) : `${(sClaim.data ?? []).length} rows CLAIMED`);
  const sSeq = await S.from("token_sequence").select("*").limit(1);
  report("student can't read token_sequence", Boolean(sSeq.error) && denied(sSeq.error?.message), sSeq.error ? sSeq.error.message.slice(0, 60) : `${(sSeq.data ?? []).length} rows READ`);
  if (own) {
    const { data: b0 } = await S.from("orders").select("created_at").eq("id", own.id).single();
    await S.from("orders").update({ created_at: new Date(0).toISOString() }).eq("id", own.id);
    const { data: a0 } = await S.from("orders").select("created_at").eq("id", own.id).single();
    report("student can't back-date their order (0036 guard)", String(a0?.created_at) === String(b0?.created_at), `${b0?.created_at} → ${a0?.created_at}`);
  }

  console.log("\n— the desk —");
  if (deskIds.length > 0) {
    const mine = deskIds[0];
    const { data: dOrders } = await D.from("orders").select("operator_id, user_id").limit(500);
    const other = (dOrders ?? []).filter(
      (o) => !deskIds.includes(o.operator_id as string) && o.user_id !== desk.userId,
    );
    report("desk sees only its own desk's orders (plus its own as a student)", other.length === 0, `${(dOrders ?? []).length} rows, ${other.length} from other desks`);
    const { data: dStaff } = await D.from("staff").select("*").limit(100);
    const dForeign = (dStaff ?? []).filter((r) => r.user_id !== desk.userId);
    report("desk account reads only its own staff row (colleagues come via list_staff)", dForeign.length === 0, `${dForeign.length} foreign`);
    const { data: listed, error: le } = await D.rpc("list_staff", { p_operator: mine });
    report("list_staff works for the desk's own desk", !le && (listed ?? []).length >= 1, le ? le.message : `${(listed ?? []).length} on staff`);
    const { data: fw, error: fe } = await D.rpc("fee_window", { p_operator: mine, p_from: new Date(0).toISOString(), p_to: new Date().toISOString() });
    report("fee_window answers for the desk's own desk", !fe && (fw ?? []).length === 1, fe ? fe.message : `fee ${fw?.[0]?.fee}`);
    // Another desk, if one exists: the same calls must come back empty.
    const { data: ops } = await D.from("operators").select("id").limit(50);
    const otherDesk = (ops ?? []).map((o) => o.id as string).find((id) => !deskIds.includes(id));
    if (otherDesk) {
      const { data: l2 } = await D.rpc("list_staff", { p_operator: otherDesk });
      report("list_staff is empty for another desk", (l2 ?? []).length === 0, `${(l2 ?? []).length} rows`);
      const { data: f2 } = await D.rpc("fee_window", { p_operator: otherDesk, p_from: new Date(0).toISOString(), p_to: new Date().toISOString() });
      report("fee_window is empty for another desk", (f2 ?? []).length === 0, `${(f2 ?? []).length} rows`);
      const upd = await D.from("operators").update({ status_note: "probe" }).eq("id", otherDesk).select("id");
      report("desk can't update another desk", (upd.data ?? []).length === 0, `${(upd.data ?? []).length} rows changed`);
    } else {
      console.log("     (only one desk exists; cross-desk probes skipped)");
    }
    if (deskIsAdmin) {
      skip("desk can't switch on online payment for itself", "this account is the admin");
    } else {
      const { data: g0 } = await D.from("operators").select("gateway_status").eq("id", mine).single();
      const flip = await D.from("operators").update({ gateway_status: g0?.gateway_status === "collect" ? "off" : "collect" }).eq("id", mine);
      const { data: g1 } = await D.from("operators").select("gateway_status").eq("id", mine).single();
      report("desk can't switch on online payment for itself (0036)", Boolean(flip.error) && g1?.gateway_status === g0?.gateway_status, flip.error ? flip.error.message.slice(0, 60) : `${g0?.gateway_status} → ${g1?.gateway_status} CHANGED`);
    }
  }
  if (deskIsAdmin) {
    skip("desk can't change the platform fee", "this account is the admin");
    skip("desk can't record its own settlement", "this account is the admin");
  } else {
    const dFee = await D.rpc("set_platform_fee", { p_percent: 20, p_min: 0, p_vpa: null, p_name: null, p_grace_days: 15 });
    if (missing(dFee.error?.message)) skip("desk can't change the platform fee", "set_platform_fee(…, p_grace_days) isn't on the project — run 0025");
    else report("desk can't change the platform fee", Boolean(dFee.error), dFee.error ? dFee.error.message.slice(0, 60) : "CHANGED");
    const dSettle = await D.rpc("record_settlement", { p_operator: deskIds[0] ?? "00000000-0000-0000-0000-000000000000", p_amount: 1, p_note: "probe" });
    report("desk can't record its own settlement", Boolean(dSettle.error), dSettle.error ? dSettle.error.message.slice(0, 60) : "RECORDED");
  }

  const tail = skipped ? ` (${skipped} skipped)` : "";
  console.log(fails === 0 ? `\nPASS - ${probes} probes, the policies held${tail}` : `\nFAIL - ${fails} of ${probes} probes let something through${tail}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nFAIL - ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
