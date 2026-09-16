import { callerId, fail, isAdminUser, isOwnerOf, refuseCrossOrigin, serviceClient } from "@/lib/server/db";
import { CashfreeError, cashfreeConfigured, createRefund, vendorShare } from "@/lib/server/cashfree";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A refund of a payment made through Printifi — the one refund that
 * actually moves money from here. The desk's owner (or the admin) asks;
 * Cashfree pays the student back onto whatever they paid with, and the
 * split is unwound in the same proportion as it was made, so the desk
 * bears its share and Printifi its fee's share. Recorded on the order by
 * the server, like the payment was.
 */
export async function POST(request: Request) {
  const foreign = await refuseCrossOrigin(request);
  if (foreign) return foreign;
  if (!cashfreeConfigured()) return fail("Online payment isn't set up on this deployment.", 503);
  const userId = await callerId();
  if (!userId) return fail("Sign in first", 401);
  const supabase = serviceClient();
  if (!supabase) return fail("SUPABASE_SERVICE_ROLE_KEY is not set.", 503);

  const body = (await request.json().catch(() => null)) as { orderId?: string; amount?: number; note?: string } | null;
  if (!body?.orderId || !/^[0-9a-f-]{36}$/i.test(body.orderId)) return fail("Which order?");
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return fail("How much?");
  const note = (body.note ?? "").trim().slice(0, 100);

  const { data: order } = await supabase
    .from("orders")
    .select("id, operator_id, total, platform_fee, gateway_order_id, gateway_payment_id, refunded_at, refund_amount")
    .eq("id", body.orderId)
    .maybeSingle();
  if (!order) return fail("No such order", 404);
  if (!(await isOwnerOf(supabase, userId, order.operator_id)) && !(await isAdminUser(supabase, userId))) return fail("Only the desk's owner refunds", 403);
  if (!order.gateway_payment_id || !order.gateway_order_id) return fail("This order wasn't paid through Printifi — record the refund on the card instead.");
  if (order.refunded_at) return fail("Already refunded.");
  const total = Number(order.total);
  if (amount > total) return fail(`At most the ${total.toFixed(2)} they paid.`);

  const { data: operator } = await supabase
    .from("operators")
    .select("gateway_vendor_id")
    .eq("id", order.operator_id)
    .maybeSingle();
  const fee = Number(order.platform_fee ?? 0);
  const deskShare = vendorShare(total, fee);
  // The desk's part of this refund, in the proportion of the original split.
  const deskPart = total > 0 ? Math.round(((amount * deskShare) / total) * 100) / 100 : 0;

  const refundId = `RF${order.id.replace(/-/g, "").slice(0, 24)}${Date.now().toString(36)}`.slice(0, 40);
  try {
    const refund = await createRefund({
      orderId: order.gateway_order_id,
      refundId,
      amount,
      note: note || undefined,
      splits: operator?.gateway_vendor_id && deskPart > 0 ? [{ vendorId: operator.gateway_vendor_id, amount: deskPart }] : undefined,
    });
    const { error } = await supabase.rpc("gateway_refunded", {
      p_order: order.id,
      p_refund_id: String(refund.cf_refund_id ?? refund.refund_id),
      p_amount: amount,
      p_note: note || null,
    });
    if (error) return fail(`Cashfree accepted the refund but the order didn't record it: ${error.message}`, 500);
    return Response.json({ ok: true, refundId: refund.refund_id, status: refund.refund_status });
  } catch (e) {
    const status = e instanceof CashfreeError ? (e.status >= 500 ? 502 : 400) : 500;
    return fail(e instanceof Error ? e.message : "Couldn't refund.", status);
  }
}
