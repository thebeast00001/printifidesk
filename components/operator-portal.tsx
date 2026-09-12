"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  Banknote,
  Check,
  ChevronDown,
  Clock,
  Download,
  ExternalLink,
  Flag,
  Loader2,
  Phone,
  Printer,
  ScanLine,
  Search,
  Smartphone,
  Star,
  Ticket,
  Undo2,
  X,
} from "lucide-react";
import {
  acceptOrder,
  advance,
  declineOrder,
  openOrderFile,
  operatorOrders,
  operatorStats,
  orderCustomer,
  setOperatorNote,
  refundOrder,
  setPriority,
  type Customer,
  type OperatorStats,
} from "@/lib/operator";
import { NEXT_STATUS, STATUS_LABEL, type Operator, type OrderRow, type OrderStatus } from "@/lib/orders";
import { money, paise, type PrintConfig } from "@/lib/pricing";
import { summarisePages } from "@/lib/pages";
import { openReports, resolveReport, type OrderReport } from "@/lib/reports";
import { useAuthKey } from "@/hooks/use-auth-key";
import { subscribeTable, type ConnectionState } from "@/lib/realtime";
import { AlertToggle, useNewOrderAlert } from "./new-order-alert";
import { useApp } from "@/lib/store";
import { AgeBadge, DueBadge, hourLabel, useNow } from "./operator/age";
import { HandledBy } from "./operator/handled-by";
import { MessageThread } from "./operator/messages";
import { NextUpBar, primaryAction } from "./operator/next-up";
import { ScanSheet } from "./operator/scan-sheet";
import { SlipDialog } from "./operator/slip";
import { cn, easeIos, spring } from "@/lib/utils";

type Tab = "inbox" | "working" | "ready" | "scheduled" | "reports" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "inbox", label: "New" },
  { id: "working", label: "Printing" },
  { id: "ready", label: "Ready" },
  { id: "scheduled", label: "Scheduled" },
  // A report lands on an order that is usually already collected — which is
  // to say, in History, inside a collapsed card. Nobody looked there. This
  // tab gathers them whatever their status.
  { id: "reports", label: "Reports" },
  { id: "history", label: "History" },
];

const STATUS_STYLE: Record<string, string> = {
  placed: "bg-clay text-clay-ink",
  queued: "border border-line bg-surface-sunk text-ink-soft",
  printing: "bg-ink text-paper",
  finishing: "bg-ink text-paper",
  ready: "bg-sage text-sage-ink",
  collected: "border border-line bg-surface-sunk text-muted",
  cancelled: "border border-line bg-surface-sunk text-muted",
  failed: "bg-clay text-clay-ink",
};

const DECLINE_REASONS = [
  "Out of paper",
  "Printer down",
  "File won't print",
  "Too large for today",
  "Closing now",
];

/**
 * The operator's working surface.
 *
 * Split by what needs doing rather than by status name: New is money not yet
 * taken, Printing is work in hand, Ready is waiting to be collected. Every
 * action writes a row a student sees over realtime, so nothing here is
 * cosmetic.
 */
export function OperatorPortal({ operator }: { operator: Operator }) {
  const authKey = useAuthKey();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [stats, setStats] = useState<OperatorStats | null>(null);
  const [tab, setTab] = useState<Tab>("inbox");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [reports, setReports] = useState<OrderReport[]>([]);
  const [scanning, setScanning] = useState(false);
  const [slipFor, setSlipFor] = useState<OrderRow | null>(null);
  // Whether the hero card's own buttons are on screen. The thumb bar exists
  // for when they aren't; drawn over them it just hides them.
  const [heroInView, setHeroInView] = useState(true);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const heroObserver = useRef<IntersectionObserver | null>(null);

  const observeHero = useCallback((node: HTMLDivElement | null) => {
    heroObserver.current?.disconnect();
    heroRef.current = node;
    if (!node) {
      setHeroInView(true);
      return;
    }
    heroObserver.current = new IntersectionObserver(
      ([entry]) => setHeroInView(entry.isIntersecting),
      // Count it as visible while any of it shows above the bar's own zone.
      { rootMargin: "0px 0px -140px 0px", threshold: 0.15 },
    );
    heroObserver.current.observe(node);
  }, []);

  useEffect(() => () => heroObserver.current?.disconnect(), []);
  // One clock for every age badge on the screen.
  const now = useNow();

  const load = useCallback(async () => {
    const [rows, s] = await Promise.all([
      operatorOrders(operator.id),
      operatorStats(operator.id),
    ]);
    setOrders(rows);
    setStats(s);
    // Scoped to this operator's own orders. RLS would refuse the rest anyway,
    // but asking for them would still be wrong.
    try {
      setReports(await openReports(rows.map((o) => o.id)));
    } catch (e) {
      // A failing reports query must not take the queue down with it, but it
      // must not be silent either — that is how "not showing" happens.
      setError(e instanceof Error ? e.message : "Couldn't load student reports.");
    }
  }, [operator.id, authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  /* The queue must move without a refresh — the operator has their hands full.
     A new order is merged straight from the payload so it lands in the same
     tick it was placed; the aggregate stats catch up right behind it. */
  useEffect(() => {
    return subscribeTable<OrderRow>({
      table: "orders",
      filter: `operator_id=eq.${operator.id}`,
      onState: setConnection,
      onChange: ({ eventType, row }) => {
        if (!row) return;

        setOrders((prev) => {
          if (!prev) return prev;
          const at = prev.findIndex((o) => o.id === row.id);
          if (eventType === "DELETE") return prev.filter((o) => o.id !== row.id);
          if (at === -1) return [...prev, row];
          const next = [...prev];
          next[at] = { ...next[at], ...row };
          return next;
        });

        // Counts and revenue are aggregates; they can lag a beat.
        void operatorStats(operator.id).then(setStats);
      },
    });
  }, [operator.id]);

  /* A report is the one thing that arrives without the order row changing, so
     it needs its own subscription. No filter: `order_reports` carries no
     operator column, and RLS already limits delivery to this desk's orders. */
  useEffect(() => {
    return subscribeTable<OrderReport>({
      table: "order_reports",
      onChange: () => {
        setOrders((rows) => {
          if (rows) {
            void openReports(rows.map((o) => o.id))
              .then(setReports)
              .catch(() => {
                /* the next load() will say why */
              });
          }
          return rows;
        });
      },
    });
  }, []);

  /* Stale data on this screen means printing the wrong thing, so poll if the
     socket drops rather than showing a frozen queue. */
  useEffect(() => {
    if (connection !== "down") return;
    const id = setInterval(() => void load(), 8000);
    return () => clearInterval(id);
  }, [connection, load]);

  async function run(id: string, action: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through.");
    } finally {
      setBusy(null);
    }
  }

  // Orders with something a student said about them, still unanswered.
  const reported = useMemo(() => new Set(reports.map((r) => r.order_id)), [reports]);

  const filtered = useMemo(() => {
    const all = orders ?? [];
    const q = query.trim().toLowerCase();

    const byTab = all.filter((o) => {
      switch (tab) {
        case "inbox":
          return o.status === "placed";
        case "working":
          return o.status === "queued" || o.status === "printing" || o.status === "finishing";
        case "ready":
          return o.status === "ready";
        case "scheduled":
          return o.pickup_mode === "scheduled" && ["placed", "queued"].includes(o.status);
        case "reports":
          return reported.has(o.id);
        case "history":
          return ["collected", "cancelled", "failed"].includes(o.status);
      }
    });

    // Newest complaint first on the Reports tab; soonest pickup first on
    // Scheduled; the queue's own order everywhere else.
    const ordered =
      tab === "reports"
        ? [...byTab].sort((a, b) => {
            const ra = reports.find((r) => r.order_id === a.id)?.created_at ?? "";
            const rb = reports.find((r) => r.order_id === b.id)?.created_at ?? "";
            return rb.localeCompare(ra);
          })
        : tab === "scheduled"
          ? [...byTab].sort((a, b) => (a.pickup_at ?? "").localeCompare(b.pickup_at ?? ""))
          : byTab;

    if (!q) return ordered;
    return ordered.filter((o) =>
      `${o.token ?? ""} ${o.order_items?.map((i) => i.name).join(" ") ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [orders, tab, query, reported, reports]);

  // Rings when the number waiting to be accepted goes up.
  const alert = useNewOrderAlert(stats ? stats.pending : null);

  const nextUp =
    !query && (tab === "inbox" || tab === "working" || tab === "ready") && filtered.length > 0
      ? filtered[0]
      : null;

  const readyOrders = useMemo(() => (orders ?? []).filter((o) => o.status === "ready"), [orders]);

  // The dock shows the same number as a badge, so the operator can see a new
  // job arrive from any face of the page.
  const setPending = useApp((s) => s.setOperatorPending);
  useEffect(() => {
    setPending(stats ? stats.pending : null);
  }, [stats, setPending]);

  const counts = useMemo(() => {
    const all = orders ?? [];
    return {
      inbox: all.filter((o) => o.status === "placed").length,
      working: all.filter((o) => ["queued", "printing", "finishing"].includes(o.status)).length,
      ready: all.filter((o) => o.status === "ready").length,
      scheduled: all.filter(
        (o) => o.pickup_mode === "scheduled" && ["placed", "queued"].includes(o.status),
      ).length,
      reports: all.filter((o) => reported.has(o.id)).length,
      history: all.filter((o) => ["collected", "cancelled", "failed"].includes(o.status)).length,
    } as Record<Tab, number>;
  }, [orders, reported]);

  return (
    <div className="flex flex-col gap-4">
      <StatStrip stats={stats} currency={operator.currency ?? "₹"} />

      <LowStock operator={operator} />
      <LiveDot connection={connection} />

      {/* A student's complaint is the one thing on this screen that isn't in
          the queue's own flow, so it gets said out loud until it's looked at. */}
      {reports.length > 0 && tab !== "reports" && (
        <button
          onClick={() => setTab("reports")}
          className="flex items-center gap-2.5 rounded-[14px] bg-clay px-4 py-3 text-left text-[12.5px] font-semibold text-clay-ink"
        >
          <Flag size={15} strokeWidth={2.2} className="shrink-0" />
          {reports.length === 1
            ? "A student has reported a problem with a print"
            : `${reports.length} students have reported problems with their prints`}
          <span className="ml-auto font-normal underline-offset-2 hover:underline">See them</span>
        </button>
      )}

      {error && (
        <p className="m-0 flex items-start gap-2 rounded-[14px] bg-clay px-4 py-3 text-[12.5px] text-clay-ink">
          <AlertCircle size={15} strokeWidth={2.2} className="mt-px shrink-0" />
          {error}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "relative flex shrink-0 items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-semibold transition-colors",
                tab === t.id ? "text-paper" : "text-muted hover:text-ink-soft",
              )}
            >
              {tab === t.id && (
                <motion.span
                  layoutId="portal-tab"
                  transition={spring}
                  className="absolute inset-0 rounded-full bg-ink"
                />
              )}
              <span className="relative">{t.label}</span>
              {counts[t.id] > 0 && (
                <span
                  className={cn(
                    "relative rounded-full px-1.5 py-0.5 font-mono text-[10px]",
                    tab === t.id ? "bg-paper/20" : "bg-surface-sunk",
                  )}
                >
                  {counts[t.id]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* One row on a phone: the search takes the width, the two buttons
            sit beside it. An icon button alone on its own row read as lost. */}
        <div className="flex items-center gap-2">
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface px-3 sm:w-[220px] sm:flex-none">
            <Search size={14} strokeWidth={2.2} className="shrink-0 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Token or file"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
          </label>
          <AlertToggle enabled={alert.enabled} onToggle={alert.toggle} />
          {readyOrders.length > 0 && (
            <button
              onClick={() => setScanning(true)}
              className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper"
            >
              <ScanLine size={14} strokeWidth={2.2} />
              <span className="hidden sm:inline">Scan to hand over</span>
              <span className="sm:hidden">Scan</span>
            </button>
          )}
        </div>
      </div>

      {orders === null ? (
        <Empty icon={<Loader2 size={16} className="animate-spin" />} title="Loading the queue…" />
      ) : filtered.length === 0 ? (
        <Empty
          icon={<Printer size={16} />}
          title={query ? `Nothing matches “${query}”` : emptyTitle(tab)}
          body={query ? undefined : emptyBody(tab)}
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          <AnimatePresence initial={false}>
            {filtered.map((order, index) => (
              <motion.div
                key={order.id}
                ref={nextUp?.id === order.id ? observeHero : undefined}
                layout="position"
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.24, ease: easeIos }}
              >
                {/* Scheduled jobs file under the hour they're due, so the
                    tab reads as a timeline rather than a list. */}
                {tab === "scheduled" &&
                  order.pickup_at &&
                  (index === 0 ||
                    hourLabel(order.pickup_at, now) !==
                      hourLabel(filtered[index - 1].pickup_at ?? order.pickup_at, now)) && (
                    <p className="label-caps m-0 mt-2 mb-2 first:mt-0">{hourLabel(order.pickup_at, now)}</p>
                  )}
                <OrderCard
                  order={order}
                  operator={operator}
                  now={now}
                  hero={nextUp?.id === order.id}
                  onSlip={() => setSlipFor(order)}
                  currency={operator.currency ?? "₹"}
                  busy={busy === order.id}
                  onAccept={() => run(order.id, () => acceptOrder(order.id))}
                  onDecline={(reason) => run(order.id, () => declineOrder(order.id, reason))}
                  onAdvance={(to, label) => run(order.id, () => advance(order.id, to, label))}
                  onPriority={() => run(order.id, () => setPriority(order.id, !order.is_priority))}
                  onNote={(note) => run(order.id, () => setOperatorNote(order.id, note))}
                  onRefund={(amount, reason) =>
                    run(order.id, () => refundOrder(order.id, amount, reason))
                  }
                  reports={reports.filter((r) => r.order_id === order.id)}
                  onResolve={(id, resolution) =>
                    run(order.id, () => resolveReport(id, resolution))
                  }
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <NextUpBar
        order={heroInView ? null : nextUp}
        busy={busy === nextUp?.id}
        onAct={(order, to, label) =>
          run(order.id, () => (to === "queued" && order.status === "placed" ? acceptOrder(order.id) : advance(order.id, to, label)))
        }
      />

      <ScanSheet
        open={scanning}
        onOpenChange={setScanning}
        operatorId={operator.id}
        ready={readyOrders}
        busy={busy !== null}
        onHandOver={(order) => {
          void run(order.id, () => advance(order.id, "collected", "Handed over")).then(() =>
            setScanning(false),
          );
        }}
      />

      <SlipDialog
        order={slipFor}
        operator={operator}
        open={slipFor !== null}
        onOpenChange={(v) => !v && setSlipFor(null)}
      />
    </div>
  );
}

/* ---------- pieces ---------- */

function StatStrip({ stats, currency }: { stats: OperatorStats | null; currency: string }) {
  const items = [
    { label: "waiting", value: stats?.pending ?? 0 },
    { label: "printing", value: stats?.printing ?? 0 },
    { label: "ready", value: stats?.ready ?? 0 },
    { label: "done today", value: stats?.done_today ?? 0 },
    { label: "pages today", value: stats?.pages_today ?? 0 },
    {
      label: "taken today",
      value: money(Math.round(Number(stats?.revenue_today ?? 0)), currency),
    },
    { label: "median mins", value: stats?.median_minutes ?? 0 },
  ];

  return (
    <div className="no-scrollbar -mx-1 flex gap-2.5 overflow-x-auto px-1">
      {items.map((item) => (
        <div
          key={item.label}
          className="min-w-[104px] flex-1 rounded-[16px] border border-line bg-surface p-3 shadow-card"
        >
          <p className="font-figure m-0 text-[22px] leading-none font-extrabold">
            {stats === null ? "—" : item.value}
          </p>
          <p className="m-0 mt-1 text-[11px] leading-snug text-muted">{item.label}</p>
        </div>
      ))}
    </div>
  );
}

function OrderCard({
  order,
  operator,
  now,
  hero,
  onSlip,
  currency,
  busy,
  onAccept,
  onDecline,
  onAdvance,
  onPriority,
  onNote,
  onRefund,
  reports,
  onResolve,
}: {
  order: OrderRow;
  operator: Operator;
  now: number;
  /** The top of the queue: bigger token, and its own label. */
  hero?: boolean;
  onSlip: () => void;
  currency: string;
  busy: boolean;
  onAccept: () => void;
  onDecline: (reason: string) => void;
  onAdvance: (to: OrderStatus, label: string) => void;
  onPriority: () => void;
  onNote: (note: string) => void;
  onRefund: (amount: number, reason: string) => void;
  reports: OrderReport[];
  onResolve: (id: string, resolution: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState(order.operator_note ?? "");
  const [opening, setOpening] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const items = order.order_items ?? [];
  const config = order.config ?? {};

  // Two files in one order can be set up differently since 0013.
  const mixed = items.some((item) => {
    const own = item.config;
    if (!own) return false;
    return (["colour", "sides", "binding", "copies"] as const).some(
      (k) => own[k] !== undefined && own[k] !== config[k],
    );
  });

  return (
    <article
      className={cn(
        "rounded-[20px] border bg-surface p-4 shadow-card lg:p-5",
        order.is_priority ? "border-ink" : "border-line",
        hero && "ring-1 ring-ink/15",
      )}
    >
      {hero && <p className="label-caps m-0 mb-3">Next up</p>}

      <div className="flex flex-wrap items-start gap-4">
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-2xl bg-surface-sunk font-mono font-medium",
            hero ? "size-[72px] text-[22px] tracking-wide" : "size-14 text-base",
          )}
        >
          {order.token ?? "—"}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
              {items.length
                ? `${items[0].name}${items.length > 1 ? ` + ${items.length - 1} more` : ""}`
                : `${order.pages} pages`}
            </h3>
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-[10.5px] font-semibold",
                STATUS_STYLE[order.status] ?? "bg-surface-sunk text-muted",
              )}
            >
              {STATUS_LABEL[order.status]}
            </span>
            {order.pickup_mode === "scheduled" && order.status !== "collected" ? (
              <DueBadge order={order} now={now} />
            ) : (
              <AgeBadge order={order} operator={operator} now={now} />
            )}
            {order.is_priority && (
              <span className="flex items-center gap-1 rounded-full bg-ink px-2.5 py-1 text-[10.5px] font-semibold text-paper">
                <Star size={10} strokeWidth={2.6} />
                Priority
              </span>
            )}
            {order.payment_claimed_at && !order.payment_taken_at && (
              <span
                className="flex items-center gap-1 rounded-full bg-bone px-2.5 py-1 text-[10.5px] font-semibold text-ink"
                title="The student says they've paid. Check your own app before accepting."
              >
                {order.payment_method === "cash" ? (
                  <Banknote size={10} strokeWidth={2.4} />
                ) : (
                  <Smartphone size={10} strokeWidth={2.4} />
                )}
                says paid
                {order.payment_method === "cash"
                  ? " (cash)"
                  : order.payment_reference
                    ? ` · ${order.payment_reference}`
                    : " by UPI"}
              </span>
            )}
            {reports.length > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-clay px-2.5 py-1 text-[10.5px] font-semibold text-clay-ink">
                <Flag size={10} strokeWidth={2.4} />
                reported
              </span>
            )}
            {order.refunded_at && (
              <span className="flex items-center gap-1 rounded-full bg-clay px-2.5 py-1 text-[10.5px] font-semibold text-clay-ink">
                <Undo2 size={10} strokeWidth={2.4} />
                refunded {money(Number(order.refund_amount ?? 0), currency)}
              </span>
            )}
            {order.pickup_mode === "scheduled" && order.pickup_at && (
              <span className="flex items-center gap-1 rounded-full bg-bone px-2.5 py-1 text-[10.5px] font-semibold text-ink">
                <Clock size={10} strokeWidth={2.4} />
                {new Date(order.pickup_at).toLocaleString([], {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            )}
          </div>

          <p className="m-0 mt-1.5 font-mono text-[11.5px] text-muted">
            {order.pages} p · {order.colour_pages} colour ·{" "}
            {mixed ? (
              // Printing this job to one setting would now be wrong, so the
              // summary refuses to give one. The per-file list is below.
              <b className="font-sans font-semibold text-ink">settings differ per file</b>
            ) : (
              <>
                {config.sides === "double" ? "duplex" : "single"} ·{" "}
                {config.binding === "staple" ? "stapled" : "loose"} · {config.copies ?? 1}×
              </>
            )}{" "}
            · {money(Number(order.total), currency)}
            {Number(order.platform_fee) > 0 && (
              // The student paid this into the desk's UPI or drawer; it's
              // Printify's, and Takings adds it up.
              <span className="text-muted"> (incl. {money(Number(order.platform_fee), currency)} Printify fee)</span>
            )}
          </p>
          <p className="m-0 mt-0.5 font-mono text-[11.5px] text-muted">
            placed {new Date(order.created_at).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            {order.operator_note ? ` · note: ${order.operator_note}` : ""}
          </p>
        </div>

        {/* On a phone this was shrink-0 and ran off the card. It now takes a
            full row beneath the title: the labelled buttons fill it in equal
            parts and wrap in pairs, and the three icon buttons sit together
            at the right. From sm up it's the compact cluster it always was. */}
        <div className="flex basis-full flex-wrap items-center gap-2 sm:basis-auto sm:shrink-0">
          {order.status === "placed" ? (
            <>
              <ActionButton onClick={onAccept} busy={busy} primary>
                <Check size={14} strokeWidth={2.6} />
                {order.payment_claimed_at ? "Confirm payment" : "Payment taken"}
              </ActionButton>
              <ActionButton onClick={() => setDeclining((v) => !v)} busy={busy}>
                <X size={14} strokeWidth={2.4} />
                Decline
              </ActionButton>
            </>
          ) : (
            (NEXT_STATUS[order.status] ?? []).map(({ to, label }) => (
              <ActionButton
                key={to}
                onClick={() => onAdvance(to, label)}
                busy={busy}
                primary={to !== "failed" && to !== "cancelled"}
              >
                {label}
              </ActionButton>
            ))
          )}

          {items.length > 0 && order.status !== "collected" && (
            <ActionButton
              onClick={async () => {
                setOpening(true);
                setFileError(null);
                try {
                  // One at a time: browsers block a burst of popups, and a
                  // print dialog per file is what the operator wants anyway.
                  for (const item of items) {
                    const file = await openOrderFile(item.id);
                    window.open(file.url, "_blank", "noopener,noreferrer");
                  }
                } catch (e) {
                  setFileError(e instanceof Error ? e.message : "Couldn't open the files.");
                } finally {
                  setOpening(false);
                }
              }}
              busy={opening}
              primary
            >
              <Download size={14} strokeWidth={2.2} />
              {items.length > 1 ? `Open ${items.length} files` : "Open file"}
            </ActionButton>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              onClick={onPriority}
              disabled={busy}
              aria-label={order.is_priority ? "Remove priority" : "Mark priority"}
              className={cn(
                "grid size-10 place-items-center rounded-xl border transition-colors disabled:opacity-50",
                order.is_priority
                  ? "border-ink bg-ink text-paper"
                  : "border-line bg-surface-sunk text-muted hover:text-ink",
              )}
            >
              <Star size={15} strokeWidth={2.2} />
            </button>

            <button
              onClick={onSlip}
              aria-label="Job slip"
              title="Job slip — print it, clip it to the pages"
              className="grid size-10 place-items-center rounded-xl border border-line bg-surface-sunk text-muted transition-colors hover:text-ink"
            >
              <Ticket size={15} strokeWidth={2.2} />
            </button>

            <button
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label="Order detail"
              className="grid size-10 place-items-center rounded-xl border border-line bg-surface-sunk text-muted transition-colors hover:text-ink"
            >
              <ChevronDown
                size={16}
                strokeWidth={2.2}
                className={cn("transition-transform", open && "rotate-180")}
              />
            </button>
          </div>
        </div>
      </div>

      {fileError && (
        <p className="m-0 mt-3 flex items-start gap-2 rounded-xl bg-clay px-3 py-2.5 text-[12px] leading-relaxed text-clay-ink">
          <AlertCircle size={14} strokeWidth={2.2} className="mt-px shrink-0" />
          {fileError}
        </p>
      )}

      <AnimatePresence initial={false}>
        {declining && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: easeIos }}
            className="overflow-hidden"
          >
            <div className="mt-3.5 rounded-[14px] bg-clay/40 p-3.5">
              <p className="m-0 mb-2.5 text-[12.5px] font-semibold">
                Why? The student sees this.
              </p>
              <div className="flex flex-wrap gap-2">
                {DECLINE_REASONS.map((reason) => (
                  <button
                    key={reason}
                    disabled={busy}
                    onClick={() => {
                      setDeclining(false);
                      onDecline(reason);
                    }}
                    className="rounded-full border border-line bg-surface px-3 py-2 text-[12px] font-semibold text-ink-soft disabled:opacity-50"
                  >
                    {reason}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: easeIos }}
            className="overflow-hidden"
          >
            <div className="mt-3.5 border-t border-line pt-3.5">
              <FileList items={items} order={config} currency={currency} />

              <CustomerLine userId={order.user_id} />

              <MessageThread
                orderId={order.id}
                canSend={!["collected", "cancelled"].includes(order.status)}
              />

              {["collected", "cancelled", "failed"].includes(order.status) && (
                <HandledBy orderId={order.id} operatorId={operator.id} />
              )}

              <p className="label-caps m-0 mt-3.5 mb-2">Your note</p>
              <div className="flex gap-2">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Only you see this"
                  className="min-w-0 flex-1 rounded-xl border border-line bg-surface-sunk px-3 py-2 text-[12.5px] outline-none focus:border-ink"
                />
                <button
                  onClick={() => onNote(note)}
                  disabled={busy || note === (order.operator_note ?? "")}
                  className="rounded-xl bg-ink px-3.5 py-2 text-[12.5px] font-semibold text-paper disabled:opacity-40"
                >
                  Save
                </button>
              </div>

              <ReportList reports={reports} busy={busy} onResolve={onResolve} />

              <RefundRow order={order} currency={currency} busy={busy} onRefund={onRefund} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function ActionButton({
  children,
  onClick,
  busy,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy: boolean;
  primary?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      transition={spring}
      disabled={busy}
      onClick={onClick}
      className={cn(
        // A 132px basis with grow: on a 340px row that is two per line,
        // stretched to fill — symmetrical whatever the count. From sm up the
        // buttons take their natural width again.
        "flex h-10 min-w-0 grow basis-[132px] items-center justify-center gap-1.5 rounded-xl px-3.5 text-[12.5px] font-semibold whitespace-nowrap transition-colors disabled:opacity-50 sm:grow-0 sm:basis-auto",
        primary ? "bg-ink text-paper" : "border border-line bg-surface-sunk text-ink-soft",
      )}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : children}
    </motion.button>
  );
}

function Empty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body?: string;
}) {
  return (
    <div className="rounded-[20px] border border-line bg-surface p-8 text-center">
      <p className="m-0 flex items-center justify-center gap-2 text-[14px] font-semibold">
        {icon}
        {title}
      </p>
      {body && <p className="m-0 mt-1.5 text-[12.5px] text-muted">{body}</p>}
    </div>
  );
}

function emptyTitle(tab: Tab) {
  return {
    inbox: "No new orders",
    working: "Nothing printing",
    ready: "Nothing waiting to be collected",
    scheduled: "No scheduled orders",
    reports: "Nothing reported",
    history: "No finished orders yet",
  }[tab];
}

function emptyBody(tab: Tab) {
  return {
    inbox: "Orders land here the moment a student sends one.",
    working: "Accept an order from New to start.",
    ready: "Finished jobs appear here until they're handed over.",
    scheduled: "Students can book a pickup time when they order.",
    reports: "When a student says a print came out wrong, it shows here — whatever the order's status.",
    history: undefined,
  }[tab];
}


/** Says plainly when the queue on screen may be behind the database. */
function LiveDot({ connection }: { connection: ConnectionState }) {
  if (connection === "live") return null;
  return (
    <p
      className={cn(
        "m-0 flex items-center gap-2 rounded-[14px] px-3.5 py-2.5 text-[12px]",
        connection === "down" ? "bg-clay text-clay-ink" : "bg-surface-sunk text-muted",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          connection === "down" ? "bg-clay-ink" : "animate-pulse bg-muted",
        )}
      />
      {connection === "down"
        ? "Reconnecting — the queue may be a few seconds behind."
        : "Connecting to the live queue…"}
    </p>
  );
}

/** Files on the order, each openable on its own for re-printing one item. */
/**
 * How one file is to be printed, in the words the person at the machine uses.
 *
 * Since 0013 each file carries its own settings, so this is per row rather than
 * per order — printing the whole job to the header's settings would now be
 * wrong. Orders placed before that have an empty config and fall back to the
 * order's, which is exactly what they were printed to.
 */
function itemSettings(
  item: NonNullable<OrderRow["order_items"]>[number],
  order: PrintConfig,
): string {
  const c = { ...order, ...(item.config ?? {}) };
  return [
    c.colour === "bw" ? "black & white" : c.colour === "full" ? "full colour" : "colour where needed",
    c.sides === "double" ? "duplex" : "single-sided",
    c.binding === "staple" ? "stapled" : "loose",
    (c.copies ?? 1) > 1 ? `${c.copies}\u00d7` : null,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

function FileList({
  items,
  order,
  currency,
}: {
  items: OrderRow["order_items"];
  order: PrintConfig;
  currency: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!items?.length) {
    return <p className="m-0 text-[12.5px] text-muted">No file list on this order.</p>;
  }

  return (
    <>
      <p className="label-caps m-0 mb-2">Files</p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 text-[12.5px]">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{item.name}</span>
              {/* The settings for this file, not for the order. Two files in
                  one job can now disagree, and printing both to the header's
                  settings is the mistake this line exists to prevent. */}
              <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">
                {itemSettings(item, order)}
              </span>
            </span>
            {/* One line, right-aligned, same baseline as the name — the stacked
                version read as two unrelated numbers. */}
            <span className="shrink-0 self-center text-right font-mono text-[11.5px] text-muted">
              <span className="block whitespace-nowrap">
                {item.pages} p
                {item.colour_pages ? ` \u00b7 ${item.colour_pages} col` : ""}
                {Number(item.price) > 0 && (
                  <>
                    {" \u00b7 "}
                    <span className="text-ink">{money(Number(item.price), currency)}</span>
                  </>
                )}
              </span>
              {item.selected_pages?.length ? (
                <span className="block text-[10.5px]">pages {summarisePages(item.selected_pages)}</span>
              ) : null}
            </span>
            <button
              disabled={busy === item.id}
              onClick={async () => {
                setBusy(item.id);
                setError(null);
                try {
                  const file = await openOrderFile(item.id);
                  window.open(file.url, "_blank", "noopener,noreferrer");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn't open it.");
                } finally {
                  setBusy(null);
                }
              }}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] font-semibold text-ink-soft disabled:opacity-50"
            >
              {busy === item.id ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <ExternalLink size={11} strokeWidth={2.2} />
              )}
              Open
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="m-0 mt-2 text-[11.5px] text-clay-ink dark:text-clay">{error}</p>}
    </>
  );
}

/**
 * Who to call when a job is unclear or goes uncollected.
 *
 * Readable only while the order is live, enforced by RLS rather than here — an
 * operator has no business browsing customers they aren't currently serving.
 */
function CustomerLine({ userId }: { userId: string }) {
  const [customer, setCustomer] = useState<Customer | null | "loading">("loading");

  useEffect(() => {
    void orderCustomer(userId).then(setCustomer);
  }, [userId]);

  if (customer === "loading" || !customer) return null;
  const where = [customer.hostel, customer.room].filter(Boolean).join(" \u00b7 ");

  return (
    <>
      <p className="label-caps m-0 mt-3.5 mb-2">Customer</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
        <span className="font-semibold">{customer.name ?? "No name saved"}</span>
        {customer.roll_no && (
          <span className="font-mono text-[11.5px] text-muted">{customer.roll_no}</span>
        )}
        {customer.phone && (
          <a
            href={`tel:${customer.phone}`}
            className="flex items-center gap-1.5 font-mono text-[11.5px] text-ink-soft underline underline-offset-2"
          >
            <Phone size={11} strokeWidth={2.2} />
            {customer.phone}
          </a>
        )}
        {where && <span className="text-[11.5px] text-muted">{where}</span>}
      </div>
    </>
  );
}

/** Warns before the tray runs out, since running out closes the desk. */
function LowStock({ operator }: { operator: Operator }) {
  const paperLow =
    operator.paper_stock !== null && operator.paper_stock <= (operator.low_paper_at ?? 100);
  const tonerLow =
    operator.toner_pages !== null && operator.toner_pages <= (operator.low_toner_at ?? 200);

  if (!paperLow && !tonerLow) return null;

  const parts = [
    paperLow ? `${operator.paper_stock} sheets` : null,
    tonerLow ? `${operator.toner_pages} toner pages` : null,
  ].filter(Boolean);

  return (
    <p className="m-0 flex items-start gap-2 rounded-[14px] bg-clay px-4 py-3 text-[12.5px] leading-relaxed text-clay-ink">
      <AlertCircle size={15} strokeWidth={2.2} className="mt-px shrink-0" />
      Running low: {parts.join(" and ")} left. Printify closes itself at zero.
    </p>
  );
}

const REFUND_REASONS = [
  "Print came out wrong",
  "Paid twice",
  "Cancelled before printing",
  "Machine broke down",
];

/**
 * Recording a refund.
 *
 * The money moves in the operator's own UPI app or out of their cash drawer —
 * nothing here can move it. What this does is write down that it happened, so
 * the student sees it on their order and the day's takings subtract it. Saying
 * so plainly matters: an operator who thinks this button sends money will not
 * send it themselves.
 */
function RefundRow({
  order,
  currency,
  busy,
  onRefund,
}: {
  order: OrderRow;
  currency: string;
  busy: boolean;
  onRefund: (amount: number, reason: string) => void;
}) {
  // To the paisa: a ₹64.20 order can be refunded ₹64.20, not ₹64.
  const total = paise(Number(order.total));
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(total));
  const [reason, setReason] = useState(REFUND_REASONS[0]);

  // Nothing to refund until the operator has actually taken the money.
  if (!order.payment_taken_at) return null;

  if (order.refunded_at) {
    return (
      <p className="m-0 mt-3.5 flex items-start gap-2 rounded-xl bg-clay/40 px-3 py-2.5 text-[12px] leading-relaxed text-ink">
        <Undo2 size={14} strokeWidth={2.2} className="mt-px shrink-0" />
        Refunded {money(Number(order.refund_amount ?? 0), currency)} on{" "}
        {new Date(order.refunded_at).toLocaleDateString([], {
          day: "numeric",
          month: "short",
        })}
        {order.refund_note ? ` — ${order.refund_note}` : ""}
      </p>
    );
  }

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0 && value <= total;

  return (
    <div className="mt-3.5">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 text-[12px] font-semibold text-muted transition-colors hover:text-ink"
        >
          <Undo2 size={13} strokeWidth={2.2} />
          Record a refund
        </button>
      ) : (
        <div className="rounded-[14px] bg-clay/40 p-3.5">
          <p className="m-0 mb-2.5 text-[12px] leading-relaxed">
            <strong className="font-semibold">Send the money yourself first.</strong> This only
            writes it down — the student sees it on their order and it comes off today&apos;s
            takings.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-semibold">Amount</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                inputMode="decimal"
                className={cn(
                  "w-24 rounded-lg border bg-surface px-2.5 py-2 font-mono text-[13px] outline-none",
                  valid ? "border-line focus:border-ink" : "border-clay-ink",
                )}
              />
            </label>

            <label className="flex min-w-[160px] flex-1 flex-col gap-1.5">
              <span className="text-[11.5px] font-semibold">Why</span>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="rounded-lg border border-line bg-surface px-2.5 py-2 text-[12.5px] outline-none focus:border-ink"
              >
                {REFUND_REASONS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>

            <div className="flex gap-2">
              <ActionButton
                onClick={() => {
                  if (!valid) return;
                  setOpen(false);
                  onRefund(value, reason);
                }}
                busy={busy}
                primary
              >
                Refund {money(valid ? paise(value) : total, currency)}
              </ActionButton>
              <ActionButton onClick={() => setOpen(false)} busy={false}>
                Cancel
              </ActionButton>
            </div>
          </div>

          {!valid && (
            <p className="m-0 mt-2 text-[11.5px] text-clay-ink">
              Between {money(1, currency)} and the {money(total, currency)} they paid.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const RESOLUTIONS = ["Reprinted", "Refunded", "Explained to them", "Not our fault"];

/**
 * What the student said went wrong.
 *
 * Sits above the refund control on purpose: the complaint is the reason a
 * refund gets recorded, and reading it first is the order the operator would
 * work in anyway.
 */
function ReportList({
  reports,
  busy,
  onResolve,
}: {
  reports: OrderReport[];
  busy: boolean;
  onResolve: (id: string, resolution: string) => void;
}) {
  if (reports.length === 0) return null;

  return (
    <div className="mt-3.5">
      <p className="label-caps m-0 mb-2">Reported by the student</p>
      {reports.map((report) => (
        <div key={report.id} className="mb-2 rounded-[14px] bg-clay/40 p-3.5 last:mb-0">
          <p className="m-0 text-[12.5px] font-semibold">{report.reason}</p>
          {report.detail && (
            <p className="m-0 mt-1 text-[12px] leading-relaxed text-ink-soft">{report.detail}</p>
          )}
          <p className="m-0 mt-1 font-mono text-[11px] text-muted">
            {new Date(report.created_at).toLocaleString([], {
              day: "numeric",
              month: "short",
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                disabled={busy}
                onClick={() => onResolve(report.id, r)}
                className="rounded-full border border-line bg-surface px-2.5 py-1.5 text-[11.5px] font-semibold text-ink-soft disabled:opacity-50"
              >
                {r}
              </button>
            ))}
          </div>
          <p className="m-0 mt-2 text-[11px] leading-snug text-muted">
            Picking one closes the report. Refunding is the separate control below — this only
            records what you did about it.
          </p>
        </div>
      ))}
    </div>
  );
}
