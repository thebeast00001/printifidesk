import { requestOrigin } from "@/lib/server/surface";
import { callerId, fail, serviceClient } from "@/lib/server/db";
import {
  CashfreeError,
  cashfreeConfigured,
  cashfreeEnv,
  createOrder,
  gatewayOrderId,
  getOrder,
  vendorShare,
} from "@/lib/server/cashfree";
import { reconcileOrder } from "../reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "I want to pay this order through Printify."
 *
 * The student's own order, still waiting for payment, at a desk Printify
 * has connected. Creates (or reuses) the Cashfree order with the split —
 * the desk's share to its vendor account, the fee to Printify — and hands
 * back the payment session the browser opens Cashfree's checkout with.
 * Nothing is marked paid here; the webhook and the status poll do that
 * from Cashfree's word, never from the browser's.
 */
export async function POST(request: Request) {
  if (!cashfreeConfigured()) return fail("Online payment isn't set up on this deployment.", 503);
  const userId = await callerId();
  if (!userId) return fail("Sign in first", 401);
  const supabase = serviceClient();
  if (!supabase) return fail("SUPABASE_SERVICE_ROLE_KEY is not set.", 503);

  const body = (await request.json().catch(() => null)) as { orderId?: string } | null;
  const orderId = body?.orderId;
  if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return fail("Which order?");

  const { data: order } = await supabase
    .from("orders")
    .select("id, user_id, operator_id, token, status, total, platform_fee, payment_taken_at, gateway_order_id, gateway_paid_at")
    .eq("id", orderId)
    .maybeSingle();
  if (!order || order.user_id !== userId) return fail("That order isn't yours.", 404);
  if (order.gateway_paid_at || order.payment_taken_at) return Response.json({ ok: true, paid: true });
  if (order.status !== "placed") return fail("This order isn't waiting for payment.");

  const { data: operator } = await supabase
    .from("operators")
    .select("id, name, short_name, gateway_vendor_id, gateway_status, shut_at")
    .eq("id", order.operator_id)
    .maybeSingle();
  if (!operator || operator.shut_at) return fail("This desk can't take payments right now.");
  if (operator.gateway_status !== "active" || !operator.gateway_vendor_id) {
    return fail("This desk doesn't take online payment through Printify yet.");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("name, email, phone")
    .eq("id", userId)
    .maybeSingle();
  const phone = (profile?.phone ?? "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  if (!/^\d{10}$/.test(phone)) {
    // Cashfree needs a phone number on every order; a made-up one would be
    // a lie on a payment record. The student adds theirs in Settings.
    return Response.json({ ok: false, needsPhone: true, error: "Add your phone number in Settings first." }, { status: 409 });
  }

  const origin = await requestOrigin();
  const total = Number(order.total);
  const fee = Number(order.platform_fee ?? 0);
  const split = { vendorId: operator.gateway_vendor_id, amount: vendorShare(total, fee) };

  try {
    // A Cashfree order already made for this one: reuse its session while
    // it's live, reconcile it if it was paid meanwhile, replace it if it
    // expired. Cashfree refuses a second order with the same id.
    if (order.gateway_order_id) {
      const existing = await getOrder(order.gateway_order_id);
      if (existing.order_status === "PAID") {
        await reconcileOrder(supabase, order.id, order.gateway_order_id);
        return Response.json({ ok: true, paid: true });
      }
      if (existing.order_status === "ACTIVE" && existing.payment_session_id) {
        return Response.json({ ok: true, paymentSessionId: existing.payment_session_id, mode: cashfreeEnv() });
      }
    }

    const attempt = order.gateway_order_id ? Number(/-(\d+)$/.exec(order.gateway_order_id)?.[1] ?? 1) + 1 : 1;
    const cfOrderId = gatewayOrderId(order.id, attempt);
    const created = await createOrder({
      orderId: cfOrderId,
      amount: total,
      customer: { id: userId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50), phone, email: profile?.email, name: profile?.name },
      note: `Printify ${order.token ?? ""} at ${operator.short_name || operator.name}`.slice(0, 200),
      returnUrl: `${origin}/orders?paid=${order.id}`,
      notifyUrl: `${origin}/api/payments/webhook`,
      split,
      tags: { printify_order: order.id, token: order.token ?? "" },
    });
    const { error } = await supabase.rpc("gateway_begin", { p_order: order.id, p_gateway_order_id: created.order_id });
    if (error) return fail(error.message, 500);
    return Response.json({ ok: true, paymentSessionId: created.payment_session_id, mode: cashfreeEnv() });
  } catch (e) {
    const status = e instanceof CashfreeError ? (e.status >= 500 ? 502 : 400) : 500;
    return fail(e instanceof Error ? e.message : "Couldn't start the payment.", status);
  }
}
