"use client";

import { useEffect, useMemo, useState } from "react";
import { Drawer } from "vaul";
import { Loader2, PencilRuler } from "lucide-react";
import { proposeRequote, type OrderRow } from "@/lib/orders";
import { DEFAULT_CONFIG, money, quoteOrder, rateCardOf, type PrintConfig, type QuoteLine } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * The desk corrects a bill before accepting the order (0039): the file said
 * two colour pages and has twelve, the count was an estimate, a page is
 * blank. Counts change; the rates don't — the new total is priced from the
 * order's own rate-card snapshot, here for the preview and in the database
 * for real, and nothing on the order moves until the student accepts.
 */
export function RequoteSheet({
  order,
  currency,
  open,
  onOpenChange,
  onSent,
}: {
  order: OrderRow;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}) {
  const items = useMemo(() => [...(order.order_items ?? [])].sort((a, b) => a.ordinal - b.ordinal), [order.order_items]);
  const [counts, setCounts] = useState<Record<string, { pages: string; colour: string }>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const next: Record<string, { pages: string; colour: string }> = {};
    for (const it of items) next[it.id] = { pages: String(it.pages), colour: String(it.colour_pages) };
    setCounts(next);
    setNote("");
    setError(null);
  }, [open, items]);

  const card = useMemo(() => rateCardOf(order.rate_card ?? undefined), [order.rate_card]);

  const lines: QuoteLine[] | null = useMemo(() => {
    const out: QuoteLine[] = [];
    for (const it of items) {
      const c = counts[it.id];
      if (!c) return null;
      const pages = Number.parseInt(c.pages, 10);
      const colour = Number.parseInt(c.colour, 10);
      if (!Number.isFinite(pages) || pages < 1 || pages > 5000) return null;
      if (!Number.isFinite(colour) || colour < 0 || colour > pages) return null;
      // The same layering the bill uses: defaults, the order's, then the file's own.
      out.push({ pages, colourPages: colour, config: { ...DEFAULT_CONFIG, ...order.config, ...(it.config ?? {}) } as PrintConfig });
    }
    return out;
  }, [items, counts, order.config]);

  const preview = lines ? quoteOrder(lines, card) : null;
  const unchanged =
    lines !== null && items.every((it, i) => lines[i].pages === it.pages && lines[i].colourPages === it.colour_pages);
  const canSend = Boolean(preview) && !unchanged && note.trim().length > 0 && note.trim().length <= 120 && !busy;

  async function send() {
    if (!lines) return;
    setBusy(true);
    setError(null);
    try {
      await proposeRequote(
        order.id,
        items.map((it, i) => ({ item_id: it.id, pages: lines[i].pages, colour_pages: lines[i].colourPages })),
        note,
      );
      onSent();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the correction.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.45)] backdrop-blur-[3px]" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-80 mx-auto flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-[30px] bg-paper outline-none">
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <Drawer.Title className="font-figure m-0 mb-1 flex items-center gap-2 text-[21px] font-extrabold">
              <PencilRuler size={18} strokeWidth={2.2} />
              Correct the bill
            </Drawer.Title>
            <Drawer.Description className="m-0 mb-4 text-[13px] leading-relaxed text-muted">
              Token {order.token ?? "—"} · priced at the rates the student ordered under. They see the new total and
              accept it, or cancel. Nothing changes until they do.
            </Drawer.Description>

            <div className="flex flex-col gap-2">
              {items.map((it) => {
                const c = counts[it.id] ?? { pages: "", colour: "" };
                return (
                  <div key={it.id} className="rounded-[14px] border border-line bg-surface p-3">
                    <p className="m-0 truncate text-[13px] font-semibold">{it.name}</p>
                    <p className="m-0 mt-0.5 text-[11.5px] text-muted">
                      Ordered as {it.pages} {it.pages === 1 ? "page" : "pages"}, {it.colour_pages} in colour
                      {(it.config?.copies ?? order.config?.copies ?? 1) > 1 ? ` · ${it.config?.copies ?? order.config?.copies} copies` : ""}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <label className="flex items-center gap-2 text-[12.5px]">
                        <span className="text-muted">Pages</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={5000}
                          value={c.pages}
                          onChange={(e) => setCounts((k) => ({ ...k, [it.id]: { ...c, pages: e.target.value } }))}
                          className="w-[84px] rounded-lg border border-line bg-surface-sunk px-2 py-1.5 font-mono text-[13px] outline-none focus:border-ink"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-[12.5px]">
                        <span className="text-muted">In colour</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={5000}
                          value={c.colour}
                          onChange={(e) => setCounts((k) => ({ ...k, [it.id]: { ...c, colour: e.target.value } }))}
                          className="w-[84px] rounded-lg border border-line bg-surface-sunk px-2 py-1.5 font-mono text-[13px] outline-none focus:border-ink"
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>

            <label className="mt-3 flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold">Why — the student reads this</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={120}
                placeholder="The file has 12 colour pages, not 2"
                className="rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] outline-none focus:border-ink"
              />
            </label>

            <div className="mt-4 flex items-center justify-between rounded-[14px] border border-line bg-surface-sunk px-3.5 py-3">
              <span className="text-[12.5px] text-muted">
                {money(Number(order.total), currency)} →
              </span>
              <span className={cn("font-figure text-[22px] font-extrabold", preview ? "" : "text-faint")}>
                {preview ? money(preview.total, currency) : "—"}
              </span>
            </div>
            {lines === null && <p className="m-0 mt-1.5 text-[11.5px] text-clay-ink dark:text-clay">Pages 1–5000; colour pages no more than the pages.</p>}
            {unchanged && lines !== null && <p className="m-0 mt-1.5 text-[11.5px] text-muted">That&apos;s the same as the order.</p>}
            {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}

            <button
              onClick={() => void send()}
              disabled={!canSend}
              className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-ink text-[14px] font-semibold text-paper disabled:opacity-50"
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              Send the corrected bill
            </button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
