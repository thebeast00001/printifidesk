"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Package, Plus } from "lucide-react";
import { adjustStock, stockLog, type StockEntry } from "@/lib/desk";
import type { Operator } from "@/lib/orders";
import { cn } from "@/lib/utils";

/**
 * Paper and toner as a ledger.
 *
 * A bare number you overwrite is a number nobody trusts by Wednesday. Every
 * change is a row: "+500, new ream, by Priya" or "−31, order A03 collected,
 * by the system". The live count on the settings form above still works; this
 * is the record of how it got there.
 */
export function StockPanel({ operator, onChanged }: { operator: Operator; onChanged: () => void }) {
  const [log, setLog] = useState<StockEntry[] | null>(null);
  const [kind, setKind] = useState<"paper" | "toner">("paper");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setLog(await stockLog(operator.id)), [operator.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const tracking = operator.paper_stock !== null || operator.toner_pages !== null;

  async function record(sign: 1 | -1) {
    const n = Number.parseInt(amount, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await adjustStock(
        operator.id,
        kind === "paper" ? { paper: sign * n } : { toner: sign * n },
        note || (sign > 0 ? (kind === "paper" ? "Paper added" : "Toner added") : "Written off"),
      );
      setAmount("");
      setNote("");
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading m-0 text-[18px] font-bold">Stock</h2>
        {tracking && (
          <p className="m-0 font-mono text-[12px] text-muted">
            {operator.paper_stock !== null && `${operator.paper_stock} sheets`}
            {operator.paper_stock !== null && operator.toner_pages !== null && " · "}
            {operator.toner_pages !== null && `${operator.toner_pages} toner pages`}
          </p>
        )}
      </div>
      <p className="m-0 mt-1 mb-3.5 text-[12.5px] text-muted">
        {tracking
          ? "Every change is written down. Collected jobs draw it down on their own."
          : "Set a starting count in the form above to start tracking; then use this to add stock."}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex gap-0.5 rounded-full border border-line bg-surface-sunk p-1">
          {(["paper", "toner"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn(
                "rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors",
                kind === k ? "bg-ink text-paper" : "text-muted hover:text-ink-soft",
              )}
            >
              {k === "paper" ? "Sheets" : "Toner pages"}
            </button>
          ))}
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder="500"
          className="w-24 rounded-lg border border-line bg-surface-sunk px-3 py-2 font-mono text-[13px] outline-none focus:border-ink"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          placeholder="New ream, jam, whatever"
          className="min-w-[140px] flex-1 rounded-lg border border-line bg-surface-sunk px-3 py-2 text-[12.5px] outline-none focus:border-ink"
        />
        <button
          onClick={() => record(1)}
          disabled={busy || !amount}
          className="flex h-10 items-center gap-1.5 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} strokeWidth={2.6} />}
          Add
        </button>
        <button
          onClick={() => record(-1)}
          disabled={busy || !amount}
          className="h-10 rounded-xl border border-line px-3.5 text-[12.5px] font-semibold text-ink-soft disabled:opacity-40"
        >
          Write off
        </button>
      </div>
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}

      <div className="mt-4 border-t border-line pt-3.5">
        <p className="label-caps m-0 mb-2">Ledger</p>
        {log === null ? (
          <p className="m-0 flex items-center gap-2 text-[12.5px] text-muted">
            <Loader2 size={13} className="animate-spin" />
            Loading…
          </p>
        ) : log.length === 0 ? (
          <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-muted">
            <Package size={13} strokeWidth={2.2} />
            Nothing recorded yet.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {log.map((e) => (
              <li
                key={e.id}
                className="flex items-baseline gap-3 border-b border-line py-1.5 text-[12px] last:border-0"
              >
                <span className="w-[68px] shrink-0 font-mono text-[11px] text-muted">
                  {new Date(e.created_at).toLocaleDateString([], { day: "numeric", month: "short" })}
                </span>
                <span
                  className={cn(
                    "w-[74px] shrink-0 font-mono tabular-nums",
                    e.paper_delta + e.toner_delta > 0 ? "text-sage-ink" : "text-ink-soft",
                  )}
                >
                  {e.paper_delta !== 0 && `${e.paper_delta > 0 ? "+" : ""}${e.paper_delta} sh`}
                  {e.paper_delta !== 0 && e.toner_delta !== 0 && " "}
                  {e.toner_delta !== 0 && `${e.toner_delta > 0 ? "+" : ""}${e.toner_delta} tp`}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-soft">{e.note ?? ""}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted">
                  {e.actor === null ? "system" : "staff"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
