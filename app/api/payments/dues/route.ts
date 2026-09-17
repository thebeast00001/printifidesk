import { requestOrigin } from "@/lib/server/surface";
import { callerId, fail, refuseCrossOrigin, serviceClient } from "@/lib/server/db";
import { CashfreeError, cashfreeConfigured, cashfreeEnv, createOrder, getPayments } from "@/lib/server/cashfree";
import { markDuesPaid } from "../reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Paying dues through Printifi (0043).
 *
 * Dues are what an uncollected cash order left on a student's account —
 * money Printifi already paid the desk. They're settled here, to Printifi's
 * own Cashfree account, never to a desk. POST begins one: the database
 * makes a dues_payments row with the amount it knows is owed and a
 * Cashfree order id derived from it; Cashfree's checkout session comes
 * back to the browser. GET asks whether it went through, marking it from
 * Cashfree's word when it did. Nothing is marked paid from the browser's.
 */

export async function POST(request: Request) {
  const foreign = await refuseCrossOrigin(request);
  if (foreign) return foreign;
  if (!cashfreeConfigured()) return fail("Paying online isn't set up on this deployment — pay at any desk instead.", 503);
  const userId = await callerId();
  if (!userId) return fail("Sign in first", 401);
  const supabase = serviceClient();
  if (!supabase) return fail("SUPABASE_SERVICE_ROLE_KEY is not set.", 503);

  const { data: profile } = await supabase
    .from("profiles")
    .select("name, email, phone, dues")
    .eq("id", userId)
    .maybeSingle();
  if (!profile || Number(profile.dues ?? 0) <= 0) return Response.json({ ok: true, paid: true });
  const phone = (profile.phone ?? "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  if (!/^\d{10}$/.test(phone)) {
    return Response.json({ ok: false, needsPhone: true, error: "Add your phone number in Settings first." }, { status: 409 });
  }

  const { data: begun, error } = await supabase.rpc("dues_begin", { p_user: userId });
  const row = begun?.[0] as { id: string; gateway_order_id: string; amount: number | string } | undefined;
  if (error || !row) return fail(error?.message ?? "Couldn't begin the payment.", 500);

  const origin = await requestOrigin();
  try {
    const created = await createOrder({
      orderId: row.gateway_order_id,
      amount: Number(row.amount),
      customer: { id: userId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50), phone, email: profile.email, name: profile.name },
      note: "Printifi — dues from an uncollected order".slice(0, 200),
      returnUrl: `${origin}/orders?dues=${row.id}`,
      notifyUrl: `${origin}/api/payments/webhook`,
      split: null,
      tags: { printify_dues: row.id },
    });
    return Response.json({ ok: true, duesId: row.id, amount: Number(row.amount), paymentSessionId: created.payment_session_id, mode: cashfreeEnv() });
  } catch (e) {
    const status = e instanceof CashfreeError ? (e.status >= 500 ? 502 : 400) : 500;
    return fail(e instanceof Error ? e.message : "Couldn't start the payment.", status);
  }
}

export async function GET(request: Request) {
  const userId = await callerId();
  if (!userId) return fail("Sign in first", 401);
  const supabase = serviceClient();
  if (!supabase) return fail("SUPABASE_SERVICE_ROLE_KEY is not set.", 503);

  const duesId = new URL(request.url).searchParams.get("dues") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(duesId)) return fail("Which payment?");
  const { data: row } = await supabase
    .from("dues_payments")
    .select("id, user_id, gateway_order_id, paid_at")
    .eq("id", duesId)
    .maybeSingle();
  if (!row || row.user_id !== userId) return fail("That payment isn't yours.", 404);
  if (row.paid_at) return Response.json({ ok: true, paid: true, attempt: "success" });

  try {
    const payments = await getPayments(row.gateway_order_id);
    const success = payments.find((p) => p.payment_status === "SUCCESS");
    if (!success) {
      const latest = payments[payments.length - 1];
      const attempt = !latest
        ? "none"
        : latest.payment_status === "FAILED" || latest.payment_status === "VOID" || latest.payment_status === "CANCELLED"
          ? "failed"
          : latest.payment_status === "USER_DROPPED"
            ? "dropped"
            : "pending";
      return Response.json({ ok: true, paid: false, attempt });
    }
    await markDuesPaid(supabase, row.id, {
      id: String(success.cf_payment_id),
      amount: Number(success.payment_amount),
      time: success.payment_time ?? null,
    });
    return Response.json({ ok: true, paid: true, attempt: "success" });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Couldn't check the payment.", 502);
  }
}
