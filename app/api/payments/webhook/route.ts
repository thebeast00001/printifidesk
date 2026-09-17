import { serviceClient } from "@/lib/server/db";
import { verifyWebhook, type PaymentWebhook } from "@/lib/server/cashfree";
import { markDuesPaid, markPaid } from "../reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cashfree's word that money moved.
 *
 * The signature is checked over the raw bytes with the client secret
 * before anything is read. A success marks the Printifi order paid
 * (idempotently — Cashfree retries); a failure or a drop is acknowledged
 * and nothing changes, because the student may simply try again. Always
 * 200 once verified, so Cashfree stops retrying; a bad signature is 401
 * and no more.
 */
export async function POST(request: Request) {
  const secret = process.env.CASHFREE_SECRET_KEY ?? "";
  const raw = await request.text();
  const ok = verifyWebhook(raw, request.headers.get("x-webhook-timestamp"), request.headers.get("x-webhook-signature"), secret);
  if (!ok) return Response.json({ ok: false, error: "Bad signature" }, { status: 401 });

  let event: PaymentWebhook;
  try {
    event = JSON.parse(raw) as PaymentWebhook;
  } catch {
    return Response.json({ ok: false, error: "Not JSON" }, { status: 400 });
  }

  if (event.type !== "PAYMENT_SUCCESS_WEBHOOK") {
    return Response.json({ ok: true, ignored: event.type });
  }

  const supabase = serviceClient();
  if (!supabase) return Response.json({ ok: false, error: "No service role" }, { status: 503 });

  const gatewayOrderId = event.data?.order?.order_id;
  const payment = event.data?.payment;
  if (!gatewayOrderId || !payment || payment.payment_status !== "SUCCESS") {
    return Response.json({ ok: true, ignored: "not a success" });
  }

  const { data: order } = await supabase
    .from("orders")
    .select("id")
    .eq("gateway_order_id", gatewayOrderId)
    .maybeSingle();
  if (!order) {
    // Not an order: a student's dues (0043), paid to Printifi itself?
    const { data: dues } = await supabase
      .from("dues_payments")
      .select("id")
      .eq("gateway_order_id", gatewayOrderId)
      .maybeSingle();
    if (dues) {
      try {
        const fresh = await markDuesPaid(supabase, dues.id, {
          id: String(payment.cf_payment_id),
          amount: Number(payment.payment_amount),
          time: payment.payment_time ?? event.event_time ?? null,
        });
        return Response.json({ ok: true, marked: fresh, dues: true });
      } catch (e) {
        return Response.json({ ok: true, refused: e instanceof Error ? e.message : String(e) });
      }
    }
    // Not ours (another app on the same Cashfree account, or a test event).
    return Response.json({ ok: true, ignored: "unknown order" });
  }

  try {
    const fresh = await markPaid(supabase, order.id, {
      id: String(payment.cf_payment_id),
      amount: Number(payment.payment_amount),
      group: payment.payment_group ?? null,
      time: payment.payment_time ?? event.event_time ?? null,
    });
    return Response.json({ ok: true, marked: fresh });
  } catch (e) {
    // A short payment, or a row that refused: say so, but don't make
    // Cashfree retry forever — the status poll and the desk can see it.
    return Response.json({ ok: true, refused: e instanceof Error ? e.message : String(e) });
  }
}
