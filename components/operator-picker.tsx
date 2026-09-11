"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, Loader2, MapPin } from "lucide-react";
import { SettingsGroup } from "./settings-ui";
import { useAuthKey } from "@/hooks/use-auth-key";
import { chooseOperator, defaultOperator, listOperators, type Operator } from "@/lib/orders";
import { ensureSession } from "@/lib/supabase/client";
import { perPage, rateCardOf } from "@/lib/pricing";
import { cn, spring } from "@/lib/utils";

/**
 * Where this student prints.
 *
 * Each operator sets their own prices and hours, so the choice is a real one —
 * the card shows the rates and current state rather than just a name.
 */
export function OperatorPicker() {
  const authKey = useAuthKey();
  const [operators, setOperators] = useState<Operator[] | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await listOperators();
    setOperators(list);
    const current = await defaultOperator();
    setChosenId(current?.id ?? null);
  }, [authKey]);

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
      note={error ?? "Prices and opening hours are set by each operator, so they differ."}
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
                </span>
                <span className="mt-1 block font-mono text-[11.5px] text-muted">
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
