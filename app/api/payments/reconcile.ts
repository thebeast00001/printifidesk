import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPayments } from "@/lib/server/cashfree";
import { drain } from "../notifications/dispatch/route";

/**
 * Marks a Printify order paid from a Cashfree payment — the one place that
 * does, used by the webhook and the status poll alike. `gateway_paid`
 * refuses a short amount and is a no-op the second time, so a webhook
 * retry racing a poll is harmless. Returns whether this call was the one
 * that marked it.
 */
export async function markPaid(
  supabase: SupabaseClient,
  orderId: string,
  payment: { id: string; amount: number; group?: string | null; time?: string | null },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("gateway_paid", {
    p_order: orderId,
    p_payment_id: String(payment.id),
    p_amount: payment.amount,
    p_group: payment.group ?? null,
    p_paid_at: payment.time ?? new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  const fresh = data === true;
  // The status change queued the student's push; send it now.
  if (fresh) void drain().catch(() => undefined);
  return fresh;
}

/**
 * Asks Cashfree what happened to an order and, if it was paid, marks it.
 * For the poll after checkout and for a session request that finds an
 * older Cashfree order already paid.
 */
export async function reconcileOrder(supabase: SupabaseClient, orderId: string, gatewayOrderId: string): Promise<boolean> {
  return (await reconcileDetailed(supabase, orderId, gatewayOrderId)).paid;
}

export type AttemptState = "none" | "pending" | "failed" | "dropped" | "success";

/**
 * The same, plus what the most recent attempt is doing — so the sheet can
 * say "nothing was charged" the moment a student backs out of their app,
 * rather than waiting out the poll.
 */
export async function reconcileDetailed(
  supabase: SupabaseClient,
  orderId: string,
  gatewayOrderId: string,
): Promise<{ paid: boolean; attempt: AttemptState }> {
  const payments = await getPayments(gatewayOrderId);
  const success = payments.find((p) => p.payment_status === "SUCCESS");
  if (!success) {
    const latest = payments[payments.length - 1];
    const attempt: AttemptState = !latest
      ? "none"
      : latest.payment_status === "FAILED" || latest.payment_status === "VOID" || latest.payment_status === "CANCELLED"
        ? "failed"
        : latest.payment_status === "USER_DROPPED"
          ? "dropped"
          : "pending";
    return { paid: false, attempt };
  }
  await markPaid(supabase, orderId, {
    id: String(success.cf_payment_id),
    amount: Number(success.payment_amount),
    group: success.payment_group ?? null,
    time: success.payment_time ?? null,
  });
  return { paid: true, attempt: "success" };
}
