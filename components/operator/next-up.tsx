"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2 } from "lucide-react";
import { NEXT_STATUS, type OrderRow, type OrderStatus } from "@/lib/orders";
import { spring } from "@/lib/utils";

/**
 * The one thing to do next, where a thumb can reach it.
 *
 * On a phone the top card's buttons are at the top of the screen and the hand
 * holding the phone is at the bottom. This bar puts the primary action for the
 * top-of-queue job just above the dock, full width. It is only ever the
 * primary action — accept, start, ready, handed over — never decline, which
 * should take a deliberate reach.
 */
export function primaryAction(order: OrderRow): { to: OrderStatus; label: string } | null {
  if (order.status === "placed") {
    return { to: "queued", label: order.payment_claimed_at ? "Confirm payment" : "Payment taken" };
  }
  const next = (NEXT_STATUS[order.status] ?? []).find((s) => s.to !== "failed" && s.to !== "cancelled");
  return next ?? null;
}

export function NextUpBar({
  order,
  busy,
  onAct,
}: {
  order: OrderRow | null;
  busy: boolean;
  onAct: (order: OrderRow, to: OrderStatus, label: string) => void;
}) {
  const action = order ? primaryAction(order) : null;
  const name = order ? (order.order_items?.[0]?.name ?? `${order.pages} pages`) : "";

  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-[calc(84px+env(safe-area-inset-bottom))] z-30 sm:hidden">
      <AnimatePresence>
        {order && action && (
          <motion.div
            key={order.id}
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={spring}
            className="pointer-events-auto flex items-center gap-3 rounded-[22px] border border-line bg-surface/[0.92] p-2 pl-3.5 shadow-dock backdrop-blur-2xl"
          >
            <span className="shrink-0 font-mono text-[15px] font-medium">{order.token ?? "—"}</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{name}</span>
            <motion.button
              whileTap={{ scale: 0.97 }}
              transition={spring}
              disabled={busy}
              onClick={() => onAct(order, action.to, action.label)}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-[16px] bg-ink px-4 text-[13.5px] font-semibold whitespace-nowrap text-paper disabled:opacity-60"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} strokeWidth={2.6} />}
              {action.label}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
