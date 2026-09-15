import { callerId, fail, isStaffOf, serviceClient } from "@/lib/server/db";
import { cashfreeConfigured } from "@/lib/server/cashfree";
import { reconcileOrder } from "../reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Has it gone through?" — asked by the pay sheet after Cashfree's checkout
 * closes, in case the webhook is a few seconds behind. The owner or the
 * desk's staff may ask. Answers from the row when it already says paid;
 * otherwise asks Cashfree and marks the row if it was.
 */
export async function GET(request: Request) {
  const userId = await callerId();
  if (!userId) return fail("Sign in first", 401);
  const supabase = serviceClient();
  if (!supabase) return fail("SUPABASE_SERVICE_ROLE_KEY is not set.", 503);

  const orderId = new URL(request.url).searchParams.get("order") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return fail("Which order?");

  const { data: order } = await supabase
    .from("orders")
    .select("id, user_id, operator_id, status, gateway_order_id, gateway_paid_at")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return fail("No such order", 404);
  if (order.user_id !== userId && !(await isStaffOf(supabase, userId, order.operator_id))) return fail("Not yours", 403);

  if (order.gateway_paid_at) return Response.json({ ok: true, paid: true, status: order.status });
  if (!order.gateway_order_id || !cashfreeConfigured()) return Response.json({ ok: true, paid: false, status: order.status });

  try {
    const paid = await reconcileOrder(supabase, order.id, order.gateway_order_id);
    return Response.json({ ok: true, paid, status: paid ? "queued" : order.status });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Couldn't check with Cashfree.", 502);
  }
}
