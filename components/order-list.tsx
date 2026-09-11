"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Flag, Loader2, X } from "lucide-react";
import { useOrderHistory } from "@/hooks/use-tracking";
import { cancelOrder, STATUS_LABEL, type OrderRow, type OrderStatus } from "@/lib/orders";
import { money } from "@/lib/pricing";
import { useApp } from "@/lib/store";
import { SignedOutNotice } from "./signed-out-notice";
import { ReportSheet } from "./report-sheet";
import { cn } from "@/lib/utils";

/* State reads as form, not just words — a live job should be findable
   without reading every row. */
const STATUS_STYLE: Record<OrderStatus, string> = {
  placed: "bg-clay text-clay-ink",
  queued: "border border-line bg-surface-sunk text-ink-soft",
  printing: "bg-ink text-paper",
  finishing: "bg-ink text-paper",
  ready: "bg-sage text-sage-ink",
  collected: "border border-line bg-surface-sunk text-muted",
  cancelled: "border border-line bg-surface-sunk text-muted",
  failed: "bg-clay text-clay-ink",
};

export function OrderList() {
  const { backend, orders, reload } = useOrderHistory();
  const openSheet = useApp((s) => s.openSheet);
  const [busy, setBusy] = useState<string | null>(null);
  const [reporting, setReporting] = useState<OrderRow | null>(null);

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
    try {
      await cancelOrder(order.id);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section data-anim="orders" className="flex flex-col gap-2.5">
      {orders.map((order) => {
        const items = order.order_items ?? [];
        const summary = items.length
          ? `${items[0].name}${items.length > 1 ? ` + ${items.length - 1} more` : ""}`
          : `${order.pages} pages`;
        const cancellable = order.status === "placed" || order.status === "queued";
        /* The capsule on the home page only holds a job while it is live, so
           this list is the only route back to one that finished. A bad print is
           usually noticed later, not at the desk. */
        const reportable =
          ["ready", "collected", "failed"].includes(order.status) && !order.refunded_at;

        return (
          <article
            key={order.id}
            className="flex items-center gap-4 rounded-[20px] border border-line bg-surface p-3.5 shadow-card transition-shadow hover:shadow-lift lg:p-5"
          >
            <span className="grid size-[52px] shrink-0 place-items-center rounded-2xl bg-surface-sunk font-mono text-sm font-medium tracking-wide text-ink-soft lg:size-[60px] lg:text-base">
              {order.token ?? "—"}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <h3 className="m-0 truncate text-[14.5px] font-semibold tracking-[-0.01em] lg:text-base">
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
                    : STATUS_LABEL[order.status]}
                </span>
              </div>

              <p className="m-0 mt-1.5 font-mono text-[11.5px] text-muted">
                {formatWhen(order.created_at)} · {items.length || 1}{" "}
                {items.length === 1 ? "file" : "files"} · {order.pages} p ·{" "}
                {money(Number(order.total))}
              </p>

              {order.note && (order.status === "failed" || order.cancelled_by === "operator") && (
                <p className="m-0 mt-1 text-[11.5px] text-clay-ink dark:text-clay">{order.note}</p>
              )}
            </div>

            {cancellable && (
              <motion.button
                whileTap={{ scale: 0.94 }}
                disabled={busy === order.id}
                onClick={() => cancel(order)}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-sunk px-3.5 py-2 text-[12.5px] font-semibold text-ink-soft disabled:opacity-50"
              >
                <X size={13} strokeWidth={2.2} />
                <span className="hidden sm:inline">Cancel</span>
              </motion.button>
            )}

            {reportable && (
              <motion.button
                whileTap={{ scale: 0.94 }}
                onClick={() => setReporting(order)}
                aria-label={`Report a problem with order ${order.token ?? ""}`}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-sunk px-3.5 py-2 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
              >
                <Flag size={13} strokeWidth={2.2} />
                <span className="hidden sm:inline">Report</span>
              </motion.button>
            )}

            {order.refunded_at && (
              <span className="shrink-0 rounded-full bg-clay px-3 py-2 text-[11.5px] font-semibold whitespace-nowrap text-clay-ink">
                Refunded {money(Number(order.refund_amount ?? 0))}
              </span>
            )}
          </article>
        );
      })}

      <ReportSheet
        order={reporting}
        open={Boolean(reporting)}
        onOpenChange={(v) => !v && setReporting(null)}
        onSent={reload}
      />
    </section>
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
