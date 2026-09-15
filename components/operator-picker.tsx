"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Check, Loader2, MapPin, Tag, Zap } from "lucide-react";
import { SettingsGroup } from "./settings-ui";
import { useAuthKey } from "@/hooks/use-auth-key";
import { chooseOperator, defaultOperator, listOperators, operatorWait, type Operator, type OperatorWait } from "@/lib/orders";
import { ensureSession } from "@/lib/supabase/client";
import { DEFAULT_CONFIG, money, perPage, quoteOrder, rateCardOf, type QuoteLine } from "@/lib/pricing";
import { linesOf, useApp } from "@/lib/store";
import { cn, spring } from "@/lib/utils";

/**
 * The job the desks are compared on: whatever is staged in the upload
 * sheet, else a plain 10-page black-and-white set. The label says which,
 * so a number is never mistaken for a promise about a different job.
 */
const SAMPLE_JOB: QuoteLine[] = [{ pages: 10, colourPages: 0, config: { ...DEFAULT_CONFIG, colour: "bw" } }];

/**
 * Which open desk is cheapest for the job and which is quickest now.
 * Strictly lowest only — a tie earns nobody a badge — and nothing at all
 * with a single desk, where "cheapest" would be a hollow word.
 */
export function pickBadges(
  entries: { id: string; open: boolean; total: number; wait: number | null }[],
): { cheapest: string | null; fastest: string | null } {
  const open = entries.filter((e) => e.open);
  if (open.length < 2) return { cheapest: null, fastest: null };
  const lowest = (key: (e: (typeof open)[number]) => number | null) => {
    const known = open.filter((e) => key(e) !== null);
    if (known.length < 2) return null;
    const sorted = [...known].sort((a, b) => key(a)! - key(b)!);
    return key(sorted[0]) === key(sorted[1]) ? null : sorted[0].id;
  };
  return { cheapest: lowest((e) => e.total), fastest: lowest((e) => e.wait) };
}

/**
 * Where this student prints.
 *
 * Each operator sets their own prices and hours, so the choice is a real one —
 * the card shows the rates and current state rather than just a name.
 */
export function OperatorPicker() {
  const authKey = useAuthKey();
  const [operators, setOperators] = useState<Operator[] | null>(null);
  const [waits, setWaits] = useState<Record<string, OperatorWait | null>>({});
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const files = useApp((s) => s.files);
  const staged = useMemo(() => linesOf(files), [files]);
  const job = staged.length > 0 ? staged : SAMPLE_JOB;

  const load = useCallback(async () => {
    const list = await listOperators();
    setOperators(list);
    const current = await defaultOperator();
    setChosenId(current?.id ?? null);
    // Each desk's queue right now, all at once; a desk that doesn't answer
    // just has no "fastest" claim.
    const pairs = await Promise.all(
      list.map(async (op) => [op.id, await operatorWait(op.id).catch(() => null)] as const),
    );
    setWaits(Object.fromEntries(pairs));
  }, [authKey]);

  const priced = useMemo(
    () =>
      (operators ?? []).map((op) => {
        const wait = waits[op.id];
        const open = Boolean(wait?.open ?? op.is_open);
        return {
          id: op.id,
          open,
          total: quoteOrder(job, rateCardOf(op)).total,
          wait: open && wait ? wait.wait_minutes : null,
        };
      }),
    [operators, waits, job],
  );
  const badges = useMemo(() => pickBadges(priced), [priced]);
  const jobLabel =
    staged.length > 0
      ? `for the ${staged.reduce((n, l) => n + l.pages * Math.max(1, l.config.copies), 0)} pages you've staged`
      : "for 10 pages, black & white";

  useEffect(() => {
    void load();
  }, [load]);

  async function pick(operator: Operator) {
    const session = await ensureSession();
    if (session.status !== "ready") {
      setError("Sign in to change where you print.");
      return;
    }

    setBusy(operator.id);
    setError(null);
    try {
      await chooseOperator(operator.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that choice.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsGroup
      title="Where you print"
      note={error ?? `Prices and hours are each desk's own. The price shown is ${jobLabel}.`}
    >
      {operators === null ? (
        <div className="flex items-center gap-2.5 p-4 text-[13px] text-muted lg:px-5">
          <Loader2 size={14} className="animate-spin" />
          Finding operators…
        </div>
      ) : operators.length === 0 ? (
        <div className="p-4 text-[13px] text-muted lg:px-5">
          No operators are listed yet.
        </div>
      ) : (
        operators.map((operator) => {
          const card = rateCardOf(operator);
          const active = operator.id === chosenId;
          const mine = priced.find((p) => p.id === operator.id);

          return (
            <motion.button
              key={operator.id}
              whileTap={{ scale: 0.99 }}
              transition={spring}
              disabled={busy !== null}
              onClick={() => pick(operator)}
              className={cn(
                "flex w-full items-center gap-3 p-4 text-left transition-colors lg:px-5",
                active ? "bg-surface-sunk" : "hover:bg-surface-sunk",
              )}
            >
              <span
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-full border",
                  active ? "border-ink bg-ink text-paper" : "border-line text-faint",
                )}
              >
                {busy === operator.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : active ? (
                  <Check size={14} strokeWidth={2.6} />
                ) : (
                  <MapPin size={14} strokeWidth={2} />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[14px] font-semibold tracking-[-0.01em]">
                    {operator.short_name || operator.name}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                      operator.is_open ? "bg-sage text-sage-ink" : "bg-clay text-clay-ink",
                    )}
                  >
                    {operator.is_open ? "Open" : "Closed"}
                  </span>
                  {badges.cheapest === operator.id && (
                    <span className="flex items-center gap-1 rounded-full bg-bone px-2 py-0.5 text-[10.5px] font-semibold text-ink">
                      <Tag size={10} strokeWidth={2.6} />
                      Cheapest for this job
                    </span>
                  )}
                  {badges.fastest === operator.id && (
                    <span className="flex items-center gap-1 rounded-full bg-bone px-2 py-0.5 text-[10.5px] font-semibold text-ink">
                      <Zap size={10} strokeWidth={2.6} />
                      Fastest right now
                    </span>
                  )}
                </span>
                <span className="mt-1 block font-mono text-[11.5px] text-muted">
                  {mine && <b className="font-semibold text-ink">{money(mine.total, card.currency)}</b>}
                  {mine && mine.wait !== null && (
                    <>
                      {" "}
                      · <b className="font-semibold text-ink">~{mine.wait} min</b>
                    </>
                  )}
                  {mine && " · "}
                  {perPage(card.bwPerPage, card.currency)} b/w ·{" "}
                  {perPage(card.colourPerPage, card.currency)} colour · {card.paperGsm} GSM
                </span>
                <span className="mt-0.5 block text-[11.5px] text-muted">{operator.campus}</span>
              </span>
            </motion.button>
          );
        })
      )}
    </SettingsGroup>
  );
}
