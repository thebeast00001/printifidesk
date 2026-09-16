"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, PencilRuler } from "lucide-react";
import { acceptRequote, cancelOrder, type OrderRow } from "@/lib/orders";
import { money } from "@/lib/pricing";
import { spring } from "@/lib/utils";

/**
 * The desk corrected the bill (0039): the file had more colour pages than
 * it said, a count was an estimate. The student reads why, and either takes
 * the new price — the order is re-priced from the desk's proposal, to the
 * paisa, and paying opens as usual — or cancels; nothing is charged either
 * way until they've said. Drawn in the capsule's own colours.
 */
export function CorrectedBill({ order, onDone }: { order: OrderRow; onDone: () => void }) {
  const [busy, setBusy] = useState<"accept" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const r = order.requote;
  if (!r || order.requote_status !== "proposed") return null;

  const act = async (which: "accept" | "cancel") => {
    setBusy(which);
    setError(null);
    try {
      if (which === "accept") await acceptRequote(order.id);
      else await cancelOrder(order.id);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-xl bg-shell-line px-3.5 py-3">
      <p className="m-0 flex items-center gap-1.5 text-[12px] font-semibold">
        <PencilRuler size={13} strokeWidth={2.4} />
        The desk corrected your bill
      </p>
      <p className="m-0 mt-1.5 text-[13px] leading-relaxed">
        <span className="text-shell-faint line-through">{money(Number(r.from))}</span>{" "}
        <b className="font-figure text-[17px] font-extrabold">{money(Number(r.total))}</b>
        <span className="text-shell-faint"> · {r.pages} {r.pages === 1 ? "page" : "pages"}, {r.colour_pages} in colour</span>
      </p>
      <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-shell-faint">&ldquo;{r.note}&rdquo;</p>
      <div className="mt-2.5 flex gap-2">
        <motion.button
          whileTap={{ scale: 0.98 }}
          transition={spring}
          disabled={busy !== null}
          onClick={() => void act("accept")}
          className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-shell-ink text-[13px] font-semibold text-shell disabled:opacity-60"
        >
          {busy === "accept" && <Loader2 size={14} className="animate-spin" />}
          Accept {money(Number(r.total))}
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.98 }}
          transition={spring}
          disabled={busy !== null}
          onClick={() => void act("cancel")}
          className="flex h-10 items-center justify-center gap-2 rounded-xl border border-shell-line px-4 text-[13px] font-semibold disabled:opacity-60"
        >
          {busy === "cancel" && <Loader2 size={14} className="animate-spin" />}
          Cancel order
        </motion.button>
      </div>
      {error && <p className="m-0 mt-2 text-[12px] text-clay">{error}</p>}
    </div>
  );
}
