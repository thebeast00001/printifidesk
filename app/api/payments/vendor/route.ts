import { callerId, fail, isAdminUser, refuseCrossOrigin, serviceClient } from "@/lib/server/db";
import { CashfreeError, cashfreeConfigured, cashfreeEnv, createVendor, getVendor, vendorStatus } from "@/lib/server/cashfree";
import { isValidVpa, normaliseVpa } from "@/lib/upi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Connecting a desk to Cashfree Easy Split — the admin's job, since it
 * commits Printifi's account. POST creates the vendor with the desk's
 * bank account or UPI id and remembers its id; GET asks Cashfree how the
 * verification is going and updates the desk's status. A desk shows
 * "pay online" only once Cashfree says ACTIVE.
 */
export async function POST(request: Request) {
  const foreign = await refuseCrossOrigin(request);
  if (foreign) return foreign;
  const gate = await adminGate();
  if (gate.fail) return gate.fail;
  const { supabase } = gate;

  const body = (await request.json().catch(() => null)) as
    | {
        operatorId?: string;
        name?: string;
        email?: string;
        phone?: string;
        accountType?: "INDIVIDUAL" | "BUSINESS";
        businessType?: string;
        pan?: string;
        bank?: { accountNumber?: string; accountHolder?: string; ifsc?: string };
        upi?: { vpa?: string; accountHolder?: string };
      }
    | null;
  if (!body?.operatorId || !/^[0-9a-f-]{36}$/i.test(body.operatorId)) return fail("Which desk?");

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim();
  const phone = (body.phone ?? "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  if (name.length < 2) return fail("The account holder's name is needed.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("A valid email is needed — Cashfree sends settlement notices to it.");
  if (!/^\d{10}$/.test(phone)) return fail("A 10-digit Indian phone number is needed.");

  const bank =
    body.bank?.accountNumber && body.bank.ifsc
      ? {
          accountNumber: body.bank.accountNumber.replace(/\s/g, ""),
          accountHolder: (body.bank.accountHolder ?? name).trim(),
          ifsc: body.bank.ifsc.trim().toUpperCase(),
        }
      : null;
  const upiRaw = body.upi?.vpa ? normaliseVpa(body.upi.vpa) : "";
  const upi = upiRaw ? { vpa: upiRaw, accountHolder: (body.upi?.accountHolder ?? name).trim() } : null;
  if (!bank && !upi) return fail("A bank account (number + IFSC) or a UPI id is needed for settlements.");
  if (bank && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bank.ifsc)) return fail("That doesn't look like an IFSC code.");
  if (bank && !/^\d{6,20}$/.test(bank.accountNumber)) return fail("That doesn't look like an account number.");
  if (upi && !isValidVpa(upi.vpa)) return fail("That doesn't look like a UPI id.");
  const pan = (body.pan ?? "").trim().toUpperCase();
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return fail("That doesn't look like a PAN.");

  const { data: operator } = await supabase
    .from("operators")
    .select("id, name, gateway_vendor_id")
    .eq("id", body.operatorId)
    .maybeSingle();
  if (!operator) return fail("No such desk", 404);
  if (operator.gateway_vendor_id) return fail("This desk already has a Cashfree vendor. Check its status instead.");

  const vendorId = `desk_${operator.id.replace(/-/g, "")}`;
  try {
    const vendor = await createVendor({
      vendorId,
      name,
      email,
      phone,
      bank,
      upi,
      kyc: { accountType: body.accountType === "BUSINESS" ? "BUSINESS" : "INDIVIDUAL", businessType: body.businessType || null, pan: pan || null },
    });
    const status = vendorStatus(vendor.status);
    const { error } = await supabase
      .from("operators")
      .update({ gateway_vendor_id: vendor.vendor_id, gateway_status: status, gateway_checked_at: new Date().toISOString() })
      .eq("id", operator.id);
    if (error) return fail(error.message, 500);
    return Response.json({ ok: true, vendorId: vendor.vendor_id, status, cashfreeStatus: vendor.status, env: cashfreeEnv() });
  } catch (e) {
    const status = e instanceof CashfreeError ? (e.status >= 500 ? 502 : 400) : 500;
    return fail(e instanceof Error ? e.message : "Couldn't create the vendor.", status);
  }
}

export async function GET(request: Request) {
  const gate = await adminGate();
  if (gate.fail) return gate.fail;
  const { supabase } = gate;

  const operatorId = new URL(request.url).searchParams.get("operator") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(operatorId)) return fail("Which desk?");
  const { data: operator } = await supabase
    .from("operators")
    .select("id, gateway_vendor_id, gateway_status")
    .eq("id", operatorId)
    .maybeSingle();
  if (!operator) return fail("No such desk", 404);
  if (!operator.gateway_vendor_id) return Response.json({ ok: true, status: "off" });

  try {
    const vendor = await getVendor(operator.gateway_vendor_id);
    const status = vendorStatus(vendor.status);
    await supabase
      .from("operators")
      .update({ gateway_status: status, gateway_checked_at: new Date().toISOString() })
      .eq("id", operator.id);
    return Response.json({ ok: true, status, cashfreeStatus: vendor.status, vendorId: vendor.vendor_id });
  } catch (e) {
    const status = e instanceof CashfreeError ? (e.status >= 500 ? 502 : 400) : 500;
    return fail(e instanceof Error ? e.message : "Couldn't reach Cashfree.", status);
  }
}

/**
 * Forget the desk's vendor here — needed when moving from sandbox to
 * production (vendors live in one environment), or when a desk changes
 * hands. Nothing at Cashfree is deleted; the desk simply stops being
 * offered online payment until it's connected again.
 */
export async function DELETE(request: Request) {
  const foreign = await refuseCrossOrigin(request);
  if (foreign) return foreign;
  const gate = await adminGate();
  if (gate.fail) return gate.fail;
  const { supabase } = gate;
  const operatorId = new URL(request.url).searchParams.get("operator") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(operatorId)) return fail("Which desk?");
  const { error } = await supabase
    .from("operators")
    .update({ gateway_vendor_id: null, gateway_status: "off", gateway_checked_at: new Date().toISOString() })
    .eq("id", operatorId);
  if (error) return fail(error.message, 500);
  return Response.json({ ok: true, status: "off" });
}

async function adminGate() {
  if (!cashfreeConfigured()) return { fail: fail("Cashfree isn't configured on this deployment (CASHFREE_APP_ID / CASHFREE_SECRET_KEY).", 503) };
  const userId = await callerId();
  if (!userId) return { fail: fail("Sign in first", 401) };
  const supabase = serviceClient();
  if (!supabase) return { fail: fail("SUPABASE_SERVICE_ROLE_KEY is not set.", 503) };
  if (!(await isAdminUser(supabase, userId))) return { fail: fail("Only the admin connects desks.", 403) };
  return { supabase, fail: null };
}
