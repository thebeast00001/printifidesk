"use client";

import { useEffect, useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import QRCode from "qrcode";
import { Printer, X } from "lucide-react";
import { orderCustomer, type Customer } from "@/lib/operator";
import type { Operator, OrderRow } from "@/lib/orders";
import { money, type PrintConfig } from "@/lib/pricing";
import { spring } from "@/lib/utils";

/**
 * The slip that goes on top of the printout on the shelf.
 *
 * Token large enough to read from across the desk, the customer's name so
 * two A03s from two days can't be confused, every file with its own settings
 * so what was asked for is on the paper next to what was printed. It shows on
 * screen, and prints on its own: the stylesheet in globals.css hides the rest
 * of the page while this is being printed.
 */
export function SlipDialog({
  order,
  operator,
  open,
  onOpenChange,
}: {
  order: OrderRow | null;
  operator: Operator;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !order) return;
    setCustomer(null);
    void orderCustomer(order.user_id).then(setCustomer);
    if (order.token) {
      // Same payload as the student's own code, so the desk's scanner reads
      // either one.
      void QRCode.toDataURL(`printify:order:${order.token}`, { margin: 0, width: 240 })
        .then(setQr)
        .catch(() => setQr(null));
    }
  }, [open, order]);

  if (!order) return null;
  const items = order.order_items ?? [];

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.45)] backdrop-blur-[3px] print:hidden" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-80 mx-auto flex max-h-[92dvh] w-full max-w-[460px] flex-col
                     rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)] print:static print:max-h-none print:rounded-none print:shadow-none"
        >
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong print:hidden" />

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-center justify-between print:hidden">
              <Drawer.Title className="font-figure m-0 text-[20px] font-extrabold">Job slip</Drawer.Title>
              <Drawer.Description className="sr-only">
                A printable slip for order {order.token ?? ""}.
              </Drawer.Description>
              <button
                onClick={() => onOpenChange(false)}
                aria-label="Close"
                className="grid size-9 place-items-center rounded-xl border border-line text-muted"
              >
                <X size={15} strokeWidth={2.2} />
              </button>
            </div>

            {/* The slip itself. Black on white regardless of theme: it is
                going onto paper, and a dark-mode slip prints as a grey block. */}
            <div className="print-slip rounded-[18px] border border-line bg-white p-5 text-[#111]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="m-0 font-mono text-[10px] tracking-[0.12em] text-[#666] uppercase">
                    {operator.short_name?.trim() || operator.name}
                  </p>
                  <p className="font-figure m-0 mt-1 text-[56px] leading-none font-extrabold tracking-[-0.03em]">
                    {order.token ?? "—"}
                  </p>
                  {order.shelf_slot && (
                    <p className="m-0 mt-1.5 font-mono text-[13px] font-semibold tracking-[0.1em] text-[#333]">
                      SHELF {order.shelf_slot}
                    </p>
                  )}
                </div>
                {qr && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={qr} alt="" className="size-[84px] shrink-0" />
                )}
              </div>

              <div className="mt-4 border-t border-dashed border-[#ccc] pt-3">
                <p className="m-0 text-[15px] font-semibold">{customer?.name ?? " "}</p>
                <p className="m-0 font-mono text-[11px] text-[#666]">
                  {[customer?.roll_no, customer?.phone].filter(Boolean).join(" · ")}
                  {" "}
                </p>
              </div>

              <ul className="m-0 mt-3 list-none p-0">
                {items.length === 0 && (
                  <li className="text-[12.5px]">{order.pages} pages</li>
                )}
                {items.map((item) => (
                  <li key={item.id} className="border-t border-[#eee] py-2 first:border-0">
                    <p className="m-0 truncate text-[12.5px] font-semibold">{item.name}</p>
                    <p className="m-0 font-mono text-[11px] text-[#555]">
                      {item.pages} p · {settingsLine({ ...order.config, ...item.config })}
                    </p>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex items-baseline justify-between border-t border-dashed border-[#ccc] pt-3">
                <span className="font-mono text-[11px] text-[#666]">
                  placed{" "}
                  {new Date(order.created_at).toLocaleString([], {
                    day: "numeric",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  {order.payment_method ? ` · ${order.payment_method}` : ""}
                </span>
                <span className="font-figure text-[20px] font-extrabold">
                  {money(Number(order.total), operator.currency ?? "₹")}
                </span>
              </div>
            </div>

            <motion.button
              whileTap={{ scale: 0.98 }}
              transition={spring}
              onClick={() => window.print()}
              className="mt-4 flex h-[50px] w-full items-center justify-center gap-2 rounded-2xl bg-ink text-[14.5px] font-semibold text-paper print:hidden"
            >
              <Printer size={16} strokeWidth={2.2} />
              Print slip
            </motion.button>
            <p className="m-0 mt-2.5 text-center text-[11px] text-muted print:hidden">
              Prints on its own — the rest of the page stays out of it.
            </p>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function settingsLine(c: Partial<PrintConfig>): string {
  return [
    c.colour === "bw" ? "b/w" : c.colour === "full" ? "colour" : "smart colour",
    c.sides === "double" ? "duplex" : "single",
    c.binding === "staple" ? "stapled" : "loose",
    (c.copies ?? 1) > 1 ? `${c.copies}×` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
