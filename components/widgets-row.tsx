"use client";

import { BarChart3, Info, Printer, Receipt } from "lucide-react";
import { WidgetAction, WidgetBase, WidgetDivider, WidgetPanel, WidgetShell } from "./widget";
import { Figure } from "./figure";
import { useTotals } from "@/hooks/use-tracking";
import { useApp } from "@/lib/store";

/**
 * Both figures come from `my_totals()`, aggregated over this account's real
 * orders. A new account sees zeros — which is the honest number.
 */
export function WidgetsRow() {
  const { totals, ready } = useTotals();
  const setBreakdownOpen = useApp((s) => s.setBreakdownOpen);

  const pages = totals?.pages ?? 0;
  const saved = Math.round(Number(totals?.saved ?? 0));
  const orders = totals?.orders ?? 0;
  const colour = totals?.colour_pages ?? 0;

  return (
    <section className="grid grid-cols-2 gap-3 lg:gap-4" data-anim="widgets">
      <WidgetShell>
        <WidgetPanel tone="sage">
          <Figure value={pages} prefix="" className="text-[31px] font-extrabold" />
          <span className="mt-1.5 text-[11.5px] leading-snug font-semibold opacity-75">
            {ready
              ? pages === 0
                ? "no pages printed yet"
                : `pages across ${orders} ${orders === 1 ? "order" : "orders"}`
              : "counting…"}
          </span>
        </WidgetPanel>

        <WidgetBase>
          <WidgetAction icon={Printer} label="Orders" onClick={() => (location.href = "/orders")} />
          <WidgetDivider />
          <WidgetAction
            icon={Receipt}
            label="Details"
            onClick={() => setBreakdownOpen(true)}
          />
        </WidgetBase>
      </WidgetShell>

      <WidgetShell>
        <WidgetPanel tone="clay">
          <Figure value={saved} className="text-[31px] font-extrabold" />
          <span className="mt-1.5 text-[11.5px] leading-snug font-semibold opacity-75">
            {ready
              ? saved === 0
                ? colour === 0
                  ? "nothing needed colour yet"
                  : "saved on colour"
                : "saved on colour so far"
              : "adding up…"}
          </span>
        </WidgetPanel>

        <WidgetBase>
          <WidgetAction icon={Info} label="How" onClick={() => setBreakdownOpen(true)} />
          <WidgetDivider />
          <WidgetAction icon={BarChart3} label="Details" onClick={() => setBreakdownOpen(true)} />
        </WidgetBase>
      </WidgetShell>
    </section>
  );
}
