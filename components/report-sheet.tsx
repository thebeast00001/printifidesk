"use client";

import { useEffect, useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import { Check, Loader2 } from "lucide-react";
import type { OrderRow } from "@/lib/orders";
import {
  REPORT_REASONS,
  reportsFor,
  submitReport,
  type OrderReport,
} from "@/lib/reports";
import { cn, spring } from "@/lib/utils";

/**
 * Telling the operator a print came out wrong.
 *
 * It deliberately promises nothing. Whether this ends in a reprint, a refund or
 * neither is the desk's call, and saying "you'll be refunded" here would be
 * writing a cheque somebody else has to honour.
 */
export function ReportSheet({
  order,
  open,
  onOpenChange,
  onSent,
}: {
  order: OrderRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}) {
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<OrderReport[] | null>(null);

  useEffect(() => {
    if (!open || !order) return;
    setError(null);
    setExisting(null);
    void reportsFor(order.id).then(setExisting);
  }, [open, order]);

  const alreadyOpen = existing?.find((r) => r.status === "open") ?? null;

  async function send() {
    if (!order) return;
    setBusy(true);
    setError(null);
    try {
      await submitReport(order.id, reason, detail);
      onSent();
      onOpenChange(false);
      setDetail("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.45)] backdrop-blur-[3px]" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-80 mx-auto flex max-h-[92dvh] w-full max-w-[520px] flex-col
                     rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]"
        >
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <Drawer.Title className="font-figure m-0 mb-1 text-[23px] font-extrabold">
              What went wrong?
            </Drawer.Title>
            <Drawer.Description className="m-0 mb-4 text-[13px] text-muted">
              {order?.token ? `Token ${order.token} · ` : ""}
              This goes to the operator who printed it.
            </Drawer.Description>

            {alreadyOpen ? (
              <div className="rounded-[16px] border border-line bg-surface p-4">
                <p className="m-0 flex items-start gap-2 text-[13px] leading-relaxed">
                  <Check size={15} strokeWidth={2.6} className="mt-px shrink-0" />
                  <span>
                    You reported this on{" "}
                    {new Date(alreadyOpen.created_at).toLocaleDateString([], {
                      day: "numeric",
                      month: "short",
                    })}
                    : <b className="font-semibold">{alreadyOpen.reason.toLowerCase()}</b>. The
                    operator can see it and hasn&apos;t closed it yet.
                  </span>
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  {REPORT_REASONS.map((r) => {
                    const active = reason === r;
                    return (
                      <motion.button
                        key={r}
                        whileTap={{ scale: 0.99 }}
                        transition={spring}
                        aria-pressed={active}
                        onClick={() => setReason(r)}
                        className={cn(
                          "flex items-center gap-2.5 rounded-[14px] border px-3.5 py-3 text-left text-[13px] font-semibold tracking-[-0.01em] transition-colors",
                          active
                            ? "border-ink bg-ink text-paper"
                            : "border-line bg-surface text-ink-soft",
                        )}
                      >
                        <span
                          className={cn(
                            "grid size-4 shrink-0 place-items-center rounded-full border",
                            active ? "border-paper" : "border-line-strong",
                          )}
                        >
                          {active && <span className="size-2 rounded-full bg-paper" />}
                        </span>
                        {r}
                      </motion.button>
                    );
                  })}
                </div>

                <label className="mt-3.5 flex flex-col gap-1.5">
                  <span className="text-[12px] font-semibold tracking-[-0.01em]">
                    Anything else <span className="font-normal text-faint">optional</span>
                  </span>
                  <textarea
                    value={detail}
                    onChange={(e) => setDetail(e.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder="Which pages, what it looked like — whatever helps them fix it."
                    className="resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] leading-relaxed outline-none focus:border-ink"
                  />
                </label>

                {error && (
                  <p className="m-0 mt-2.5 text-[12px] text-clay-ink dark:text-clay">{error}</p>
                )}

                <motion.button
                  whileTap={{ scale: 0.98 }}
                  transition={spring}
                  disabled={busy}
                  onClick={send}
                  className="mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-ink text-[15px] font-semibold text-paper disabled:opacity-60"
                >
                  {busy && <Loader2 size={16} className="animate-spin" />}
                  {busy ? "Sending…" : "Send to the operator"}
                </motion.button>

                <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">
                  What happens next is theirs to decide — a reprint, a refund, or an explanation.
                  Printify doesn&apos;t hold your money, so it can&apos;t return it for them.
                </p>
              </>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
