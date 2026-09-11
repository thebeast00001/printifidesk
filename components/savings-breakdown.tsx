"use client";

import { Drawer } from "vaul";
import { Loader2, ShieldCheck } from "lucide-react";
import { useOrderHistory } from "@/hooks/use-tracking";
import { useApp } from "@/lib/store";
import { money } from "@/lib/pricing";

/**
 * The saving, job by job, from real orders. `full_colour_total` is stored on
 * the order at the moment it's placed, so this is a difference between two
 * recorded numbers rather than a recomputation that could drift.
 */
export function SavingsBreakdown() {
  const open = useApp((s) => s.breakdownOpen);
  const setOpen = useApp((s) => s.setBreakdownOpen);
  const { backend, orders } = useOrderHistory();

  const counted = orders.filter((o) => o.status !== "cancelled");
  const totalPages = counted.reduce((n, o) => n + o.pages, 0);
  const totalColour = counted.reduce((n, o) => n + o.colour_pages, 0);
  const totalSaved = counted.reduce(
    (n, o) => n + (Number(o.full_colour_total) - Number(o.total)),
    0,
  );

  return (
    <Drawer.Root open={open} onOpenChange={setOpen}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-[rgb(12_12_14/0.42)] backdrop-blur-[3px]" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-60 mx-auto flex max-h-[85dvh] w-full max-w-[560px] flex-col
                     rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]"
        >
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5 pb-[max(24px,env(safe-area-inset-bottom))]">
            <Drawer.Title className="font-figure m-0 mb-1 text-[23px] font-extrabold">
              Colour savings
            </Drawer.Title>
            <Drawer.Description className="m-0 mb-4 text-[13px] leading-relaxed text-muted">
              A shop charges the colour rate for a whole document if any page has colour. We check
              each page and charge the black &amp; white rate for the rest.
            </Drawer.Description>

            {backend.state === "loading" && (
              <p className="flex items-center gap-2.5 py-6 text-[13px] text-muted">
                <Loader2 size={15} className="animate-spin" />
                Reading your orders…
              </p>
            )}

            {backend.state === "ready" && counted.length === 0 && (
              <div className="rounded-[16px] border border-line bg-surface p-6 text-center">
                <p className="m-0 text-[13.5px] font-semibold">No orders yet</p>
                <p className="m-0 mt-1.5 text-[12.5px] leading-relaxed text-muted">
                  Once you print something, the difference between what you paid and the full-colour
                  price shows up here.
                </p>
              </div>
            )}

            {backend.state === "ready" && counted.length > 0 && (
              <>
                <div className="mb-4 flex gap-3 rounded-[16px] bg-sage px-4 py-3.5 text-[12.5px] leading-relaxed text-sage-ink">
                  <ShieldCheck size={16} strokeWidth={2.2} className="mt-px shrink-0" />
                  <span>
                    Across {counted.length} {counted.length === 1 ? "order" : "orders"}:{" "}
                    <b className="font-bold">{totalPages} pages</b>, of which{" "}
                    <b className="font-bold">{totalColour}</b> needed colour ink.
                  </span>
                </div>

                <div className="overflow-hidden rounded-[18px] border border-line bg-surface">
                  <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
                    <span className="label-caps flex-1">Order</span>
                    <span className="label-caps w-14 text-right">Colour</span>
                    <span className="label-caps w-16 text-right">Saved</span>
                  </div>

                  {counted.map((order) => {
                    const saved = Number(order.full_colour_total) - Number(order.total);
                    const first = order.order_items?.[0]?.name;
                    return (
                      <div
                        key={order.id}
                        className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em]">
                            {first ?? `Order ${order.token ?? ""}`}
                          </span>
                          <span className="mt-0.5 block font-mono text-[11px] text-muted">
                            {order.pages} pages ·{" "}
                            {new Date(order.created_at).toLocaleDateString([], {
                              day: "numeric",
                              month: "short",
                            })}
                          </span>
                        </span>
                        <span className="w-14 text-right font-mono text-[12px] text-muted">
                          {order.colour_pages}/{order.pages}
                        </span>
                        <span className="w-16 text-right font-mono text-[12.5px] font-medium">
                          {money(Math.round(saved))}
                        </span>
                      </div>
                    );
                  })}

                  <div className="flex items-center gap-3 bg-surface-sunk px-4 py-3">
                    <span className="flex-1 text-[13px] font-semibold">Total saved</span>
                    <span className="font-figure text-[20px] font-extrabold">
                      {money(Math.round(totalSaved))}
                    </span>
                  </div>
                </div>
              </>
            )}

            <p className="mt-3.5 mb-0 text-[11.5px] leading-relaxed text-muted">
              Measured from each page&apos;s own drawing instructions, not from the file type. A
              scanned page that only looks grey still counts as black &amp; white.
            </p>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
