"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { boardRows, getOperator, listOperators, type BoardRow, type Operator } from "@/lib/orders";
import { subscribeTable } from "@/lib/realtime";
import { cn, easeIos } from "@/lib/utils";

/**
 * Tokens on a wall.
 *
 * Three groups, biggest first: ready to collect (with the shelf slot),
 * printing, in line. Every row comes from board() — a security-definer
 * query open to anyone, returning tokens, statuses and slots, nothing
 * else. It polls every five seconds because the screen is usually not
 * signed in and realtime respects RLS; when it *is* signed in as the desk,
 * the socket brings changes sooner and the poll is just a backstop. The
 * clock in the corner is the honest sign that it's alive.
 */
const POLL_MS = 5_000;

export function Board() {
  const params = useSearchParams();
  const deskParam = params.get("desk");
  const [operator, setOperator] = useState<Operator | null | undefined>(undefined);
  const [choices, setChoices] = useState<Operator[] | null>(null);
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef(false);

  // Which desk. Named in the URL, or — with exactly one listed — that one.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (deskParam) {
        const op = await getOperator(deskParam, true);
        if (alive) setOperator(op ?? null);
        return;
      }
      const all = await listOperators();
      if (!alive) return;
      if (all.length === 1) setOperator(all[0]);
      else {
        setOperator(null);
        setChoices(all);
      }
    })();
    return () => {
      alive = false;
    };
  }, [deskParam]);

  const load = useCallback(async () => {
    if (!operator || inflight.current) return;
    inflight.current = true;
    try {
      const next = await boardRows(operator.id);
      setRows(next);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach Printify.");
    } finally {
      inflight.current = false;
    }
  }, [operator]);

  useEffect(() => {
    if (!operator) return;
    void load();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    // Signed in as the desk, changes arrive over the socket too.
    const stop = subscribeTable({ table: "orders", filter: `operator_id=eq.${operator.id}`, onChange: () => void load() });
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      stop();
    };
  }, [operator, load]);

  // The clock, and "updated Ns ago".
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (operator === undefined) {
    // Deciding which desk: the frame alone, no flash of "which desk?".
    return <Frame title="Printify">{null}</Frame>;
  }

  if (!operator) {
    return (
      <Frame title="Printify">
        <div className="mx-auto max-w-[520px] px-6 py-16 text-center">
          <p className="font-heading m-0 text-[28px] font-extrabold">Which desk?</p>
          <p className="m-0 mt-2 text-[15px] text-muted">
            Open this page from the desk&apos;s Settings, or pick one.
          </p>
          <div className="mt-6 flex flex-col gap-2">
            {(choices ?? []).map((op) => (
              <Link
                key={op.id}
                href={`/board?desk=${op.id}`}
                className="rounded-2xl border border-line bg-surface px-5 py-4 text-[17px] font-semibold"
              >
                {op.short_name || op.name}
              </Link>
            ))}
          </div>
        </div>
      </Frame>
    );
  }

  const ready = rows.filter((r) => r.status === "ready");
  const printing = rows.filter((r) => r.status === "printing" || r.status === "finishing");
  const inLine = rows.filter((r) => r.status === "queued");
  const stale = updatedAt !== null && now - updatedAt > POLL_MS * 4;

  return (
    <Frame
      title={operator.short_name || operator.name}
      open={operator.is_open}
      clock={new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      stale={stale || Boolean(error)}
    >
      <div className="grid min-h-[calc(100dvh-88px)] grid-cols-1 gap-px bg-line lg:grid-cols-[3fr_2fr]">
        <Column
          title="Ready to collect"
          hint={ready.length === 0 ? "Nothing on the shelf right now" : "Show your token at the counter"}
          tone="sage"
        >
          <Tokens rows={ready} big showSlot />
        </Column>
        <div className="grid grid-rows-2 gap-px bg-line">
          <Column title="Printing" hint={printing.length === 0 ? "Machine is idle" : undefined}>
            <Tokens rows={printing} />
          </Column>
          <Column title="In line" hint={inLine.length === 0 ? "No one waiting" : `${inLine.length} ahead`}>
            <Tokens rows={inLine} dim />
          </Column>
        </div>
      </div>
    </Frame>
  );
}

function Frame({
  title,
  open,
  clock,
  stale,
  children,
}: {
  title: string;
  open?: boolean;
  clock?: string;
  stale?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="flex h-[88px] items-center justify-between border-b border-line px-6 lg:px-10">
        <div className="flex items-center gap-4">
          <span className="font-heading text-[28px] font-extrabold tracking-[-0.02em] lg:text-[34px]">{title}</span>
          {open !== undefined && (
            <span
              className={cn(
                "rounded-full px-3 py-1 text-[13px] font-semibold",
                open ? "bg-sage text-sage-ink" : "bg-clay text-clay-ink",
              )}
            >
              {open ? "Open" : "Closed"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 font-mono text-[15px] text-muted lg:text-[18px]">
          {stale && <span className="text-clay-ink dark:text-clay">reconnecting…</span>}
          {clock && <span className="tabular-nums">{clock}</span>}
          <span className="text-[12px] tracking-[0.12em] uppercase opacity-60">Printify</span>
        </div>
      </header>
      {children}
    </div>
  );
}

function Column({
  title,
  hint,
  tone,
  children,
}: {
  title: string;
  hint?: string;
  tone?: "sage";
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex min-h-[220px] flex-col bg-paper p-6 lg:p-8", tone === "sage" && "bg-sage/20")}>
      <p className="label-caps m-0 text-[13px] lg:text-[15px]">{title}</p>
      {hint && <p className="m-0 mt-1 text-[14px] text-muted lg:text-[16px]">{hint}</p>}
      <div className="mt-4 flex flex-wrap content-start gap-3 lg:gap-4">{children}</div>
    </section>
  );
}

function Tokens({ rows, big, dim, showSlot }: { rows: BoardRow[]; big?: boolean; dim?: boolean; showSlot?: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {rows.map((row) => (
        <motion.div
          key={row.token}
          layout
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.28, ease: easeIos }}
          className={cn(
            "flex flex-col items-center justify-center rounded-[22px] border border-line bg-surface shadow-card",
            big ? "min-w-[150px] px-6 py-4 lg:min-w-[190px] lg:px-8 lg:py-5" : "min-w-[96px] px-4 py-2.5 lg:min-w-[120px] lg:px-5 lg:py-3",
            dim && "opacity-70",
          )}
        >
          <span
            className={cn(
              "font-figure leading-none font-extrabold tracking-[-0.03em] tabular-nums",
              big ? "text-[64px] lg:text-[88px]" : "text-[36px] lg:text-[48px]",
            )}
          >
            {row.token}
          </span>
          {showSlot && (
            <span className="mt-1.5 font-mono text-[15px] font-semibold tracking-[0.08em] text-sage-ink lg:text-[20px]">
              {row.shelf_slot ? `SHELF ${row.shelf_slot}` : "AT THE COUNTER"}
            </span>
          )}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
