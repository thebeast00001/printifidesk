"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, MonitorPlay } from "lucide-react";
import { shelfSlots, updateOperator, type Operator } from "@/lib/orders";
import { cn } from "@/lib/utils";

/**
 * The shelf, and the screen.
 *
 * Shelf: rows lettered A.., slots per row numbered 1... The moment a job is
 * marked ready the database hands it the lowest slot no other ready job
 * holds (0030); it's on the slip, the card, the student's phone and the
 * board. Zero rows switches the whole thing off.
 *
 * Board: /board?desk=<id> shows tokens queued, printing and ready in type
 * you can read from the door — no names, no files. Open it on any browser
 * pointed at the counter; it keeps itself current.
 */
export function ShelfPanel({ operator, onSaved }: { operator: Operator; onSaved: () => void }) {
  const [rows, setRows] = useState(String(operator.shelf_rows ?? 0));
  const [cols, setCols] = useState(String(operator.shelf_cols ?? 9));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setRows(String(operator.shelf_rows ?? 0));
    setCols(String(operator.shelf_cols ?? 9));
  }, [operator.shelf_rows, operator.shelf_cols]);

  const r = Number.parseInt(rows, 10);
  const c = Number.parseInt(cols, 10);
  const valid = Number.isInteger(r) && r >= 0 && r <= 8 && Number.isInteger(c) && c >= 1 && c <= 20;
  const dirty = valid && (r !== (operator.shelf_rows ?? 0) || c !== (operator.shelf_cols ?? 9));
  const slots = valid ? shelfSlots(r, c) : [];

  async function save() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await updateOperator(operator.id, { shelf_rows: r, shelf_cols: c });
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  const boardUrl =
    typeof window === "undefined" ? `/board?desk=${operator.id}` : `${window.location.origin}/board?desk=${operator.id}`;

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <h2 className="font-heading m-0 text-[18px] font-bold">Shelf and board</h2>
      <p className="m-0 mt-1 mb-3.5 text-[12.5px] text-muted">
        Every job marked ready gets a slot — printed on the slip, shown to the student, on the board.
        Set rows to 0 for no shelf.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-semibold">Rows (A–{r > 0 && r <= 8 ? String.fromCharCode(64 + r) : "H"})</span>
          <input
            value={rows}
            onChange={(e) => setRows(e.target.value.replace(/\D/g, "").slice(0, 1))}
            inputMode="numeric"
            className="w-20 rounded-lg border border-line bg-surface-sunk px-3 py-2 font-mono text-[13px] outline-none focus:border-ink"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-semibold">Slots per row</span>
          <input
            value={cols}
            onChange={(e) => setCols(e.target.value.replace(/\D/g, "").slice(0, 2))}
            inputMode="numeric"
            className="w-20 rounded-lg border border-line bg-surface-sunk px-3 py-2 font-mono text-[13px] outline-none focus:border-ink"
          />
        </label>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className={cn(
            "flex h-10 items-center gap-1.5 rounded-xl px-3.5 text-[12.5px] font-semibold transition-colors",
            dirty ? "bg-ink text-paper" : "border border-line text-faint",
          )}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} strokeWidth={2.6} /> : null}
          {saving ? "Saving…" : saved ? "Saved" : "Save shelf"}
        </button>
      </div>
      {!valid && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">Up to 8 rows and 20 slots a row.</p>}
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}

      {slots.length > 0 && (
        <p className="m-0 mt-3 font-mono text-[11.5px] leading-relaxed text-muted">
          {slots.length} slots: {slots.slice(0, 6).join(", ")}
          {slots.length > 6 ? ` … ${slots[slots.length - 1]}` : ""}. Filled lowest first; freed when the packet leaves.
        </p>
      )}

      <div className="mt-4 border-t border-line pt-3.5">
        <p className="m-0 flex items-center gap-1.5 text-[13px] font-semibold">
          <MonitorPlay size={14} strokeWidth={2.2} />
          Counter board
        </p>
        <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">
          Tokens queued, printing and ready, in type you can read from the door. No names. Open it on
          a TV or a spare phone at the counter; it keeps itself current.
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <a
            href={boardUrl}
            target="_blank"
            rel="noreferrer"
            className="flex h-10 items-center gap-1.5 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper"
          >
            <ExternalLink size={13} strokeWidth={2.4} />
            Open the board
          </a>
          <button
            onClick={async () => {
              await navigator.clipboard?.writeText(boardUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
            className="flex h-10 max-w-full items-center gap-1.5 rounded-xl border border-line px-3.5 font-mono text-[11.5px] text-ink-soft"
          >
            <Copy size={12} strokeWidth={2.4} className="shrink-0" />
            <span className="truncate">{copied ? "Copied" : boardUrl}</span>
          </button>
        </div>
      </div>
    </section>
  );
}
