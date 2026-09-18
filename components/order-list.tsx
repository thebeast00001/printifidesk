"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Check, ChevronDown, Flag, Loader2, Receipt, X } from "lucide-react";
import { useOrderHistory } from "@/hooks/use-tracking";
import { paymentBalance, cancelOrder, getOperator, STATUS_LABEL, whereTo, type Operator, type OrderRow, type OrderStatus } from "@/lib/orders";
import { awaitPaid } from "@/lib/gateway";
import { billFor } from "@/lib/bill";
import { Bill } from "./bill";
import { money } from "@/lib/pricing";
import { useApp } from "@/lib/store";
import { SignedOutNotice } from "./signed-out-notice";
import { ReportSheet } from "./report-sheet";
import { cn, easeIos } from "@/lib/utils";

/** One shape for every control on a card: a 40px square that grows a label on a wide screen. */
const ACTION =
  "flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-sunk px-2.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink disabled:opacity-50 sm:px-3.5";

/* State reads as form, not just words — a live job should be findable
   without reading every row. */
const STATUS_STYLE: Record<OrderStatus, string> = {
  placed: "bg-clay text-clay-ink",
  queued: "border border-line bg-surface-sunk text-ink-soft",
  printing: "bg-ink text-paper",
  finishing: "bg-ink text-paper",
  ready: "bg-sage text-sage-ink",
  delivering: "bg-sage text-sage-ink",
  collected: "border border-line bg-surface-sunk text-muted",
  cancelled: "border border-line bg-surface-sunk text-muted",
  failed: "bg-clay text-clay-ink",
  unclaimed: "border border-line bg-surface-sunk text-muted",
};

export function OrderList() {
  const { backend, orders, reload } = useOrderHistory();
  const openSheet = useApp((s) => s.openSheet);

  // Back from Cashfree's own page (`/orders?paid=<id>`): on a phone, a UPI
  // app switch can end there instead of in the modal. The server is asked
  // straight away — it reads Cashfree, not the webhook — so the card turns
  // paid now rather than when the webhook lands; the row itself arrives
  // over realtime. The address is tidied so a reload doesn't ask again.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const paid = url.searchParams.get("paid");
    if (!paid || !/^[0-9a-f-]{36}$/i.test(paid)) return;
    url.searchParams.delete("paid");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    void awaitPaid(paid, 8).then((outcome) => {
      if (outcome.kind === "paid") reload();
    });
  }, [reload]);
  const [busy, setBusy] = useState<string | null>(null);
  const [reporting, setReporting] = useState<OrderRow | null>(null);
  // A refused cancel says why under the card, instead of a button that does nothing.
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);

  if (backend.state === "loading") {
    return (
      <Shell>
        <Loader2 size={15} className="animate-spin" />
        Loading your orders…
      </Shell>
    );
  }

  if (backend.state === "signed-out") {
    return (
      <SignedOutNotice
        title="Sign in to see your orders"
        body="Orders are tied to your account so only you can see your tokens and files."
      />
    );
  }

  if (backend.state === "unconfigured") {
    return (
      <Shell tone="clay">
        <AlertCircle size={15} strokeWidth={2.2} />
        {backend.message}
      </Shell>
    );
  }

  if (backend.state === "error") {
    return (
      <Shell tone="clay">
        <AlertCircle size={15} strokeWidth={2.2} />
        {backend.message}
      </Shell>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="rounded-[20px] border border-line bg-surface p-8 text-center shadow-card">
        <p className="m-0 text-[14px] font-semibold tracking-[-0.01em]">No orders yet</p>
        <p className="m-0 mt-1.5 text-[12.5px] text-muted">
          Upload something and it will appear here the moment it&apos;s placed.
        </p>
        <button
          onClick={() => openSheet("upload")}
          className="mt-4 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-semibold text-paper"
        >
          Upload files
        </button>
      </div>
    );
  }

  async function cancel(order: OrderRow) {
    setBusy(order.id);
    setProblem(null);
    try {
      await cancelOrder(order.id);
      await reload();
    } catch (e) {
      setProblem({ id: order.id, message: e instanceof Error ? e.message : "Couldn't cancel that." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section data-anim="orders" className="flex flex-col gap-2.5">
      {orders.map((order) => (
        <OrderCard
          key={order.id}
          order={order}
          busy={busy === order.id}
          problem={problem?.id === order.id ? problem.message : null}
          onCancel={() => cancel(order)}
          onReport={() => setReporting(order)}
        />
      ))}

      <ReportSheet
        order={reporting}
        open={Boolean(reporting)}
        onOpenChange={(v) => !v && setReporting(null)}
        onSent={reload}
      />
    </section>
  );
}

/**
 * One past or present order, and — a tap away — its bill.
 *
 * The bill is rebuilt from the rate card the order was priced with and its
 * items, the same inputs the database had, so it is what was charged rather
 * than a fresh estimate. If those inputs can't reproduce the stored total
 * (an order older than the snapshot), it says so and the stored total wins.
 */
function OrderCard({
  order,
  busy,
  problem,
  onCancel,
  onReport,
}: {
  order: OrderRow;
  busy: boolean;
  /** Why the last cancel was refused, if it was. */
  problem?: string | null;
  onCancel: () => void;
  onReport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fallback, setFallback] = useState<Operator | null>(null);

  const items = order.order_items ?? [];
  const summary = items.length
    ? `${items[0].name}${items.length > 1 ? ` + ${items.length - 1} more` : ""}`
    : `${order.pages} pages`;
  const cancellable = order.status === "placed" || order.status === "queued";
  /* The capsule on the home page only holds a job while it is live, so this
     list is the only route back to one that finished. A bad print is usually
     noticed later, not at the desk. */
  const reportable = ["ready", "collected", "failed"].includes(order.status) && !order.refunded_at;

  // Orders from before the snapshot existed need today's rates to draw a bill
  // at all. Fetched only when opened, and only when there's no snapshot.
  useEffect(() => {
    if (!open || order.rate_card || fallback) return;
    void getOperator(order.operator_id).then(setFallback);
  }, [open, order.rate_card, order.operator_id, fallback]);

  const bill = open ? billFor(order, fallback) : null;

  return (
    <article className="rounded-[20px] border border-line bg-surface shadow-card transition-shadow hover:shadow-lift">
      {/* Token, then the words, then the buttons. On a phone the buttons
          take a line of their own under the words (the row wraps at the
          `basis`), so the title and the chips get the card's width instead
          of the sliver left beside three buttons. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-3.5 lg:p-5">
        <span className="grid size-[52px] shrink-0 place-items-center rounded-2xl bg-surface-sunk font-mono text-sm font-medium tracking-wide text-ink-soft lg:size-[60px] lg:text-base">
          {order.token ?? "—"}
        </span>

        <div className="min-w-0 flex-1 basis-[200px]">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h3 className="m-0 min-w-0 max-w-full truncate text-[14.5px] font-semibold tracking-[-0.01em] lg:text-base">
              {summary}
            </h3>
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-[10.5px] font-semibold whitespace-nowrap",
                order.cancelled_by === "operator" ? "bg-clay text-clay-ink" : STATUS_STYLE[order.status],
              )}
            >
              {order.status === "cancelled" && order.cancelled_by === "operator"
                ? "Declined"
                : order.status === "ready" && order.delivery
                  ? (order.returned_at ? "Back at the desk" : "Printed, going out")
                  : order.status === "collected" && order.delivered_at
                    ? "Delivered"
                    : STATUS_LABEL[order.status]}
            </span>
            {order.status === "ready" && order.shelf_slot && !order.delivery && (
              <span className="rounded-full border border-sage-ink/30 bg-sage px-2.5 py-1 font-mono text-[10.5px] font-semibold whitespace-nowrap text-sage-ink">
                Shelf {order.shelf_slot}
              </span>
            )}
            {/* Delivery (0046): where it's going, from the order's own snapshot. */}
            {order.delivery && !["cancelled", "failed"].includes(order.status) && (
              <span className="max-w-full truncate rounded-full border border-line bg-surface-sunk px-2.5 py-1 text-[10.5px] font-semibold whitespace-nowrap text-ink-soft">
                To {whereTo(order) || "the spot you chose"}
              </span>
            )}
            {/* The desk's word (or Cashfree's), never the student's own claim. */}
            {order.payment_taken_at && !order.refunded_at && order.status !== "cancelled" && order.status !== "failed" && (
              <span className="flex items-center gap-1 rounded-full bg-sage px-2.5 py-1 text-[10.5px] font-semibold whitespace-nowrap text-sage-ink">
                <Check size={10} strokeWidth={2.8} />
                {order.payment_method === "gateway" ? "Paid online" : "Paid"}
              </span>
            )}
          </div>

          <p className="m-0 mt-1.5 font-mono text-[11.5px] text-muted">
            {formatWhen(order.created_at)} · {items.length || 1}{" "}
            {items.length === 1 ? "file" : "files"} · {order.pages} p ·{" "}
            <span className="text-ink">{money(Number(order.total))}</span>
          </p>

          {order.note && (order.status === "failed" || order.cancelled_by === "operator") && (
            <p className="m-0 mt-1 text-[11.5px] text-clay-ink dark:text-clay">{order.note}</p>
          )}
          {problem && <p className="m-0 mt-1 text-[11.5px] text-clay-ink dark:text-clay">Couldn&apos;t cancel: {problem}</p>}
        </div>

        {/* Every control the same height and corner, so a row of them reads
            as one row; on a phone they're icons and sit under the words. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {cancellable && (
            <motion.button
              whileTap={{ scale: 0.94 }}
              disabled={busy}
              onClick={onCancel}
              aria-label={`Cancel order ${order.token ?? ""}`}
              className={ACTION}
            >
              <X size={14} strokeWidth={2.2} />
              <span className="hidden sm:inline">Cancel</span>
            </motion.button>
          )}

          {reportable && (
            <motion.button
              whileTap={{ scale: 0.94 }}
              onClick={onReport}
              aria-label={`Report a problem with order ${order.token ?? ""}`}
              className={ACTION}
            >
              <Flag size={14} strokeWidth={2.2} />
              <span className="hidden sm:inline">Report</span>
            </motion.button>
          )}

          {order.refunded_at && (
            <span className="flex h-10 items-center rounded-xl bg-clay px-3 text-[11.5px] font-semibold whitespace-nowrap text-clay-ink">
              Refunded {money(Number(order.refund_amount ?? 0))}
            </span>
          )}

          {/* A receipt once there's a payment to receipt. */}
          {order.payment_taken_at && (
            <Link
              href={`/receipt/${order.id}`}
              aria-label={`Receipt for order ${order.token ?? ""}`}
              title="Receipt — print it or save it as a PDF"
              className={ACTION}
            >
              <Receipt size={15} strokeWidth={2.2} />
            </Link>
          )}

          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Bill" className={ACTION}>
            <ChevronDown
              size={16}
              strokeWidth={2.2}
              className={cn("transition-transform", open && "rotate-180")}
            />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: easeIos }}
            className="overflow-hidden"
          >
            <div className="border-t border-line px-3.5 pt-3.5 pb-4 lg:px-5">
              {!bill ? (
                <p className="m-0 flex items-center gap-2 text-[12.5px] text-muted">
                  <Loader2 size={13} className="animate-spin" />
                  Working out the bill…
                </p>
              ) : (
                <>
                  <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="label-caps m-0">Bill</p>
                    <p className="m-0 font-mono text-[10.5px] text-muted">
                      {bill.snapshot
                        ? "at the rates when you ordered"
                        : "estimated at today's rates — placed before rates were kept"}
                    </p>
                  </div>

                  <Bill quote={bill.quote} card={bill.card} names={bill.names} />

                  {!bill.exact && (
                    <p className="m-0 mt-2.5 text-[11.5px] leading-relaxed text-muted">
                      You were charged <b className="font-semibold text-ink">{money(Number(order.total))}</b>.
                      The lines above are today&apos;s rates applied to the same files, so they may not add
                      to that.
                    </p>
                  )}

                  <PaymentLine order={order} />
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

/** How it was paid, and whether the desk has confirmed. Facts, not hopes. */
function PaymentLine({ order }: { order: OrderRow }) {
  const paid = Boolean(order.payment_taken_at);
  const claimed = Boolean(order.payment_claimed_at);
  const method = order.payment_method === "cash"
    ? (order.delivered_at ? "cash to the runner" : "cash at the desk")
    : order.payment_method === "upi" ? "UPI" : null;

  const balance = paymentBalance(order);

  let text: string;
  if (order.refunded_at) {
    text = `Refunded ${money(Number(order.refund_amount ?? 0))}${order.refund_note ? ` — ${order.refund_note.toLowerCase()}` : ""}.`;
  } else if (paid && balance.short > 0) {
    // The desk received less than the bill: the rest is taken at the counter.
    text = `The desk received ${money(balance.received ?? 0)} of ${money(Number(order.total))} — pay the remaining ${money(balance.short)} in cash when you collect.`;
  } else if (paid && balance.over > 0) {
    text = `The desk received ${money(balance.received ?? 0)} for a ${money(Number(order.total))} bill — it will return ${money(balance.over)} to you.`;
  } else if (paid && order.payment_method === "gateway") {
    text = `Paid online through Printifi${order.payment_reference ? ` · ref ${order.payment_reference}` : ""}.`;
  } else if (paid && order.delivered_at && order.payment_method === "cash") {
    text = `Paid in cash to Printifi's runner when it was handed to you${order.delivery_proof === "scan" ? " — your code was scanned" : ""}.`;
  } else if (paid) {
    text = `Paid${method ? ` by ${method}` : ""}, confirmed by the desk${
      order.payment_reference ? ` · ref ${order.payment_reference}` : ""
    }${order.shortfall_cleared_at ? " · the rest taken in cash" : ""}.`;
  } else if (order.pay_at_pickup && order.delivery && (order.status === "delivering" || order.status === "ready" || order.status === "queued" || order.status === "printing" || order.status === "finishing")) {
    text = `Pay ${money(Number(order.total))} in cash to the runner when it's handed to you.`;
  } else if (claimed) {
    text = `You marked this paid${method ? ` by ${method}` : ""}; the desk hasn't confirmed it yet.`;
  } else if (order.status === "unclaimed") {
    text = `Not collected within the desk's window, so it was cleared from the shelf${paid ? " — the payment stands, since it was printed" : ""}. Ask at the counter if you still need it.`;
  } else if (order.status === "placed") {
    text = order.requote_status === "proposed" ? "The desk corrected the bill — accept the new price or cancel." : "Not paid yet.";
  } else if (order.status === "cancelled" && order.cancelled_by === "system") {
    text = `${order.note ?? "Not paid in time"}. Nothing was charged.`;
  } else if (order.status === "cancelled" || order.status === "failed") {
    text = "Nothing was charged.";
  } else {
    text = "";
  }

  if (!text) return null;
  return (
    <p className="m-0 mt-3 flex items-start gap-1.5 border-t border-line pt-2.5 text-[12px] text-muted">
      <Receipt size={13} strokeWidth={2.2} className="mt-px shrink-0" />
      {text}
    </p>
  );
}

function Shell({ children, tone }: { children: React.ReactNode; tone?: "clay" }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-[20px] border p-4 text-[13px] lg:p-5",
        tone === "clay" ? "border-clay bg-clay/25 text-ink" : "border-line bg-surface text-muted",
      )}
    >
      {children}
    </div>
  );
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today, ${time}`;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}
