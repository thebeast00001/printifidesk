"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Printer } from "lucide-react";
import { billFor } from "@/lib/bill";
import { getOperator, STATUS_LABEL, type Operator, type OrderRow } from "@/lib/orders";
import { ensureSession, getSupabase } from "@/lib/supabase/client";
import { money } from "@/lib/pricing";
import { Bill } from "./bill";

/**
 * A receipt for an order (0039): the desk, the token, every line of the
 * bill as it was priced, how it was paid and when. Rebuilt from the order's
 * own rate-card snapshot, so it is the bill that was charged, not today's
 * rates. "Save as PDF" is the browser's print dialog — on a phone, the
 * share sheet — which is the one route to a file that works everywhere
 * without a server making one. Nothing here is invented: an order with no
 * confirmed payment says so.
 */
export function ReceiptView({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderRow | null | undefined>(undefined);
  const [operator, setOperator] = useState<Operator | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const session = await ensureSession();
      const supabase = getSupabase();
      if (session.status !== "ready" || !supabase) return alive && setOrder(null);
      const { data } = await supabase
        .from("orders")
        .select("*, order_items(id, name, pages, colour_pages, selected_pages, price, config, ordinal)")
        .eq("id", orderId)
        .maybeSingle();
      if (!alive) return;
      const row = (data as OrderRow | null) ?? null;
      setOrder(row);
      if (row) setOperator(await getOperator(row.operator_id));
    })();
    return () => {
      alive = false;
    };
  }, [orderId]);

  if (order === undefined) {
    return (
      <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
        <Loader2 size={15} className="animate-spin" />
        Loading…
      </p>
    );
  }
  if (!order) {
    return (
      <p className="m-0 text-[13px] text-muted">
        No such order on this account.{" "}
        <Link href="/orders" className="font-semibold text-ink underline-offset-2 hover:underline">Your orders</Link>
      </p>
    );
  }

  const bill = billFor(order, operator);
  const currency = bill?.card.currency ?? operator?.currency ?? "₹";
  const paid = Boolean(order.payment_taken_at);
  const method =
    order.payment_method === "gateway"
      ? "online, through Printify (Cashfree)"
      : order.payment_method === "cash"
        ? "cash at the desk"
        : order.payment_method === "upi"
          ? "UPI to the desk"
          : null;
  const when = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

  return (
    <div className="receipt">
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <Link href="/orders" className="flex items-center gap-1.5 text-[12.5px] font-semibold text-muted hover:text-ink">
          <ArrowLeft size={14} strokeWidth={2.2} />
          Orders
        </Link>
        <button
          onClick={() => window.print()}
          className="ml-auto flex h-10 items-center gap-2 rounded-xl bg-ink px-3.5 text-[13px] font-semibold text-paper"
        >
          <Printer size={14} strokeWidth={2.2} />
          Print or save as PDF
        </button>
      </div>

      <article className="rounded-[20px] border border-line bg-surface p-5 text-[13px] leading-relaxed print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
          <div>
            <p className="label-caps m-0">Printify · receipt</p>
            <h1 className="font-heading m-0 mt-1 text-[20px] font-bold">{operator?.short_name || operator?.name || "Print desk"}</h1>
            {operator?.campus && <p className="m-0 text-[12.5px] text-muted">{operator.campus}</p>}
          </div>
          <div className="text-right">
            <p className="m-0 font-mono text-[22px] font-semibold tracking-wide">{order.token ?? "—"}</p>
            <p className="m-0 font-mono text-[10.5px] text-muted">{order.id}</p>
          </div>
        </header>

        <dl className="my-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
          <dt className="text-muted">Placed</dt>
          <dd className="m-0">{when(order.created_at)}</dd>
          <dt className="text-muted">Status</dt>
          <dd className="m-0">{STATUS_LABEL[order.status]}{order.collected_at ? ` · ${when(order.collected_at)}` : ""}</dd>
          <dt className="text-muted">Payment</dt>
          <dd className="m-0">
            {paid ? (
              <>
                Paid {method ? `by ${method}` : ""} · {when(order.payment_taken_at)}
                {order.payment_reference ? <span className="font-mono text-[11.5px] text-muted"> · ref {order.payment_reference}</span> : null}
              </>
            ) : (
              "No payment confirmed"
            )}
          </dd>
          {order.refunded_at && (
            <>
              <dt className="text-muted">Refunded</dt>
              <dd className="m-0">
                {money(Number(order.refund_amount ?? 0), currency)} · {when(order.refunded_at)}
                {order.refund_note ? ` — ${order.refund_note}` : ""}
              </dd>
            </>
          )}
        </dl>

        {bill ? (
          <>
            <Bill quote={bill.quote} card={bill.card} names={bill.names} />
            {!bill.exact && (
              <p className="m-0 mt-2 text-[11.5px] text-muted">
                Rebuilt from today&apos;s rates — this order predates the rate snapshot. The amount charged was{" "}
                {money(Number(order.total), currency)}.
              </p>
            )}
          </>
        ) : (
          <p className="m-0">Total {money(Number(order.total), currency)}</p>
        )}

        <footer className="mt-5 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
          The desk&apos;s price and Printify&apos;s platform fee are shown as separate lines; the platform fee is
          Printify&apos;s. Printed from printifi.store on {when(new Date().toISOString())}.
        </footer>
      </article>

      {/* Paper is white, and the app's chrome stays on the screen. */}
      <style>{`@media print { body { background: #fff !important; } nav, [data-dock], [data-app-chrome] { display: none !important; } }`}</style>
    </div>
  );
}
