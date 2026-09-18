"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useGoogleSignIn } from "./sign-in/google-button";
import { useSurface } from "./surface-provider";
import { AlertCircle, Flag, Footprints, Loader2, LogIn, RotateCcw } from "lucide-react";
import { useActiveOrder } from "@/hooks/use-tracking";
import { STATUS_LABEL, signalLeaving, type OrderEventRow, type OrderRow, type QueueStatus } from "@/lib/orders";
import { money } from "@/lib/pricing";
import { useApp } from "@/lib/store";
import type { ConnectionState } from "@/lib/realtime";
import { PaySheet } from "./pay-sheet";
import { clearFlight, useCheckoutFlight } from "@/lib/gateway";
import { ReportSheet } from "./report-sheet";
import { CorrectedBill } from "./corrected-bill";
import { DeskMessages } from "./desk-messages";
import { isPairedDevice } from "@/lib/desk-auth";
import Link from "next/link";
import { MonitorSmartphone } from "lucide-react";
import { cn, easeIos, spring } from "@/lib/utils";

/**
 * The live job capsule. Every value in it comes from a database row: the token
 * from the insert trigger, the status from whatever the operator last did, the
 * queue position and wait from `queue_status()`. Nothing here advances on a
 * timer — if it moves, something really happened.
 */
export function StatusIsland() {
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [reporting, setReporting] = useState(false);
  const openSheet = useApp((s) => s.openSheet);
  const { backend, order, events, queue, connection, reload } = useActiveOrder();

  // A checkout that ended: paid needs nothing from here (the row moves on
  // its own; ask once anyway so the capsule turns at once); anything else
  // reopens the pay sheet, which starts with the outcome in hand.
  const flight = useCheckoutFlight();
  const flightDone = flight?.phase === "done" ? flight : null;
  useEffect(() => {
    if (!flightDone) return;
    if (order?.id !== flightDone.orderId) {
      clearFlight();
      return;
    }
    if (flightDone.outcome?.kind === "paid") {
      clearFlight();
      reload();
      return;
    }
    setPaying(true);
  }, [flightDone, order?.id, reload]);

  if (backend.state === "loading") return <IslandSkeleton />;

  if (backend.state === "signed-out") return <SignedOutIsland />;

  if (backend.state === "unconfigured" || backend.state === "error") {
    return (
      <IslandShell>
        <IslandRow
          icon={<AlertCircle size={16} strokeWidth={2.2} className="text-clay" />}
          title="Can't reach Printifi"
          sub="Check your connection and try again"
        />
      </IslandShell>
    );
  }

  if (!order) return <NoActiveOrder />;

  return (
    <>
      <LiveOrder
        order={order}
        events={events}
        queue={queue}
        connection={connection}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        onPay={() => setPaying(true)}
        onStartOver={() => openSheet("upload")}
        onReport={() => setReporting(true)}
        onChanged={reload}
      />
      <PaySheet
        order={order}
        open={paying}
        onOpenChange={setPaying}
        onClaimed={reload}
      />
      <ReportSheet
        order={order}
        open={reporting}
        onOpenChange={setReporting}
        onSent={reload}
      />
    </>
  );
}

function LiveOrder({
  order,
  events,
  queue,
  connection,
  open,
  onToggle,
  onPay,
  onStartOver,
  onReport,
  onChanged,
}: {
  order: OrderRow;
  events: OrderEventRow[];
  queue: QueueStatus | null;
  connection: ConnectionState;
  open: boolean;
  onToggle: () => void;
  onPay: () => void;
  onStartOver: () => void;
  onReport: () => void;
  onChanged: () => void;
}) {
  const barRef = useRef<HTMLSpanElement>(null);
  const [, tick] = useState(0);
  const progress = progressFor(order, queue);
  // 0043: an above-limit cash order waits for this tap before the desk prints.
  const awaitingSignal = order.status === "placed" && order.print_on_signal === true && !order.signalled_at;
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  async function leaveNow() {
    setLeaving(true);
    setLeaveError(null);
    try {
      await signalLeaving(order.id);
      onChanged();
    } catch (e) {
      setLeaveError(e instanceof Error ? e.message : "Couldn't send that.");
    } finally {
      setLeaving(false);
    }
  }

  // The estimate is derived from elapsed time, so it needs a heartbeat.
  useEffect(() => {
    if (order.status !== "queued") return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [order.status]);
  const done = order.status === "ready" || order.status === "delivering" || order.status === "collected";
  const failed = order.status === "failed" || order.status === "cancelled";

  // A job that didn't happen through no fault of the student's. Their own
  // cancellation is not one of these — they already know what to do next.
  const declined = order.status === "cancelled" && order.cancelled_by === "operator";
  const printFailed = order.status === "failed";

  /* GSAP owns the fill: it retargets mid-flight when a realtime update lands
     before the previous tween finished. */
  useGSAP(
    () => {
      gsap.to(barRef.current, {
        width: `${progress}%`,
        duration: 0.85,
        ease: "power3.out",
        overwrite: "auto",
      });
    },
    { dependencies: [progress] },
  );

  return (
    <IslandShell open={open}>
      <motion.button
        layout="position"
        whileTap={{ scale: 0.985 }}
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 text-left"
      >
        <Pulse done={done} failed={failed} />

        <span className="min-w-0 flex-1">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={order.status + (queue?.place ?? "")}
              initial={{ opacity: 0, y: 8, filter: "blur(3px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -8, filter: "blur(3px)" }}
              transition={{ duration: 0.42, ease: easeIos }}
              className="block"
            >
              <span className="block truncate text-[15px] leading-tight font-semibold tracking-[-0.01em]">
                {headline(order, queue)}
              </span>
              <span className="mt-px block truncate text-[12.5px] leading-snug text-shell-faint">
                {detail(order, queue)}
              </span>
            </motion.span>
          </AnimatePresence>
        </span>

        {connection === "down" && (
          <span
            title="Reconnecting — this may be a few seconds behind"
            className="size-1.5 shrink-0 rounded-full bg-clay"
          />
        )}
        {order.token && (
          <span className="shrink-0 rounded-lg bg-shell-line px-2.5 py-[5px] font-mono text-xs font-medium tracking-wide">
            {order.token}
          </span>
        )}
      </motion.button>

      {/* The code the desk scans at the counter — or the runner at the door (0046). */}
      {(order.status === "ready" || order.status === "delivering") && order.token && (
        <HandoverCode token={order.token} code={order.handover_code} operatorId={order.operator_id} />
      )}

      <DeskMessages orderId={order.id} visible={open} />

      {/* Declined and failed were the only two states that ended in a sentence
          with nothing to do next. Both leave the student holding a job that
          didn't happen, which is exactly when a dead end costs the most. */}
      {(printFailed || declined) && (
        <div className="mt-3 flex flex-wrap gap-2">
          <motion.button
            layout="position"
            whileTap={{ scale: 0.98 }}
            transition={spring}
            onClick={onStartOver}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-shell-ink px-4 text-[13.5px] font-semibold text-shell"
          >
            <RotateCcw size={15} strokeWidth={2.2} />
            Try again
          </motion.button>

          {printFailed && (
            <motion.button
              layout="position"
              whileTap={{ scale: 0.98 }}
              transition={spring}
              onClick={onReport}
              className="flex h-11 items-center justify-center gap-2 rounded-xl border border-shell-line px-4 text-[13.5px] font-semibold"
            >
              <Flag size={15} strokeWidth={2.2} />
              Report
            </motion.button>
          )}
        </div>
      )}

      {/* Collected, but wrong. The refund control on the operator's side is
          what makes this worth offering. */}
      {order.status === "collected" && !order.refunded_at && (
        <button
          onClick={onReport}
          className="mt-3 flex items-center gap-1.5 text-[12px] font-semibold text-shell-faint transition-colors hover:text-shell-ink"
        >
          <Flag size={13} strokeWidth={2.2} />
          Something wrong with this print?
        </button>
      )}

      {order.refunded_at && (
        <p className="m-0 mt-3 rounded-xl bg-shell-line px-3 py-2.5 text-[12px] leading-relaxed">
          The operator refunded {money(Number(order.refund_amount ?? 0))}
          {order.refund_note ? ` — ${order.refund_note.toLowerCase()}` : ""}. It comes back the
          same way you paid, so check your UPI app or ask at the desk.
        </p>
      )}

      {/* The desk corrected the bill: a yes or a cancel before any paying. */}
      <CorrectedBill order={order} onDone={onChanged} />

      {order.status === "placed" && !order.payment_claimed_at && order.requote_status !== "proposed" && (
        <motion.button
          layout="position"
          whileTap={{ scale: 0.98 }}
          onClick={onPay}
          className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-shell-ink text-[14px] font-semibold text-shell"
        >
          Pay now
        </motion.button>
      )}

      {/* Cash above the limit: the desk prints on this word, so it's ready
          by the time the student walks in — and a "just in case" order is
          never printed at all. */}
      {awaitingSignal && (
        <>
          <motion.button
            layout="position"
            whileTap={{ scale: 0.98 }}
            disabled={leaving}
            onClick={() => void leaveNow()}
            className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-shell-ink text-[14px] font-semibold text-shell disabled:opacity-60"
          >
            {leaving ? <Loader2 size={15} className="animate-spin" /> : <Footprints size={15} strokeWidth={2.2} />}
            Leaving now — start printing
          </motion.button>
          <p className="m-0 mt-2 text-[11.5px] leading-relaxed text-shell-faint">
            Tap when you set off. The desk prints it then, and you pay {money(Number(order.total))} in cash when you collect.
          </p>
          {leaveError && <p className="m-0 mt-1.5 text-[12px] text-clay">{leaveError}</p>}
        </>
      )}

      <StageTrack order={order} fillRef={barRef} done={done} failed={failed} />

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.44, ease: easeIos }}
            className="overflow-hidden"
          >
            <Timeline events={events} order={order} />
          </motion.div>
        )}
      </AnimatePresence>
    </IslandShell>
  );
}

/* ---------- copy derived from the row, never invented ---------- */

function headline(order: OrderRow, queue: QueueStatus | null): string {
  if (order.status === "cancelled" && order.cancelled_by === "operator") return "Declined";
  if (order.status === "queued" && queue) return `In queue, number ${queue.place}`;
  // A delivery (0046) isn't "ready for pickup": it's printed and waiting for the runner's round.
  if (order.status === "ready" && order.delivery) return order.returned_at ? "Back at the desk" : "Printed — going out next round";
  if (order.status === "collected" && order.delivered_at) return "Delivered";
  return STATUS_LABEL[order.status];
}

/** "Ganga 213" — where a delivery goes, from the order's own snapshot. */
function whereTo(order: OrderRow): string {
  return [order.deliver_to?.hostel, order.deliver_to?.room].filter(Boolean).join(" ");
}

function detail(order: OrderRow, queue: QueueStatus | null): string {
  const sheets = `${order.pages} ${order.pages === 1 ? "page" : "pages"}`;
  // Confirmed by the desk or by Cashfree — a fact on the row, so it leads.
  // A cash-at-pickup order (0043) isn't paid yet; it says what's owed instead.
  const cashDue = order.pay_at_pickup && !order.payment_taken_at && !order.gateway_paid_at;
  const paid = order.payment_taken_at && !order.refunded_at
    ? (order.payment_method === "gateway" ? "Paid online" : "Paid")
    : cashDue ? `${money(Number(order.total))} cash ${order.delivery ? "at your door" : "at the counter"}` : null;
  const lead = (rest: string) => (paid ? `${paid} · ${rest}` : rest);

  // Delivery (0046): the shelf and the counter aren't where this one ends.
  if (order.delivery) {
    if (order.status === "ready") {
      return order.returned_at
        ? (order.note ?? "Couldn't be delivered — collect it at the desk with your token, or wait for the next round")
        : lead(`goes out to ${whereTo(order) || "your room"} on the next delivery round`);
    }
    if (order.status === "delivering") {
      return [
        `with Printifi's runner, heading to ${whereTo(order) || "you"}`,
        "have your QR ready at the door",
        cashDue ? `pay ${money(Number(order.total))} in cash` : null,
      ]
        .filter(Boolean)
        .join(" · ")
        .replace(/^with/, "With");
    }
    if (order.status === "collected" && order.delivered_at) return `${sheets} · delivered to ${whereTo(order) || "your room"}`;
  }

  switch (order.status) {
    case "placed":
      if (order.requote_status === "proposed") return `${sheets} · the desk corrected the bill — accept or cancel`;
      if (order.print_on_signal && !order.signalled_at) return `${sheets} · cash at the counter — tap Leaving now when you set off`;
      return order.payment_claimed_at
        ? `${sheets} · waiting for the operator to confirm`
        : `${sheets} · pay to join the queue`;
    case "queued": {
      if (!queue) return lead(sheets);
      const by = readyBy(order, queue);
      return lead(
        [remaining(order, queue), by ? `ready by ${by}` : null, `${queue.pages_ahead} pages ahead of you`]
          .filter(Boolean)
          .join(" · "),
      );
    }
    case "printing":
    case "finishing":
      return lead(`${sheets} · ${order.config?.sides === "double" ? "both sides" : "one side"}`);
    case "ready":
      return [
        order.shelf_slot ? `Shelf ${order.shelf_slot}` : null,
        order.token ? `show token ${order.token} to collect` : "waiting for you to collect",
        cashDue ? `pay ${money(Number(order.total))} in cash` : null,
      ]
        .filter(Boolean)
        .join(" · ")
        .replace(/^show/, "Show")
        .replace(/^waiting/, "Waiting");
    case "collected":
      return `${sheets} · collected`;
    case "unclaimed":
      return order.covered_at
        ? `${money(Number(order.total))} is due on your account — pay it to order again`
        : (order.note ?? "Not collected in time — ask at the counter if you still need it");
    case "failed":
      return order.note ?? "Something went wrong while printing";
    case "cancelled":
      return order.cancelled_by === "operator"
        ? (order.note ?? "The operator couldn't take this one")
        : (order.note ?? "Cancelled");
    default:
      return sheets;
  }
}

/**
 * Counts the estimate down from when the job actually joined the queue, rather
 * than restating the same number for twenty minutes. It never goes below
 * "any moment now" — a countdown that hits zero and keeps sitting there is
 * worse than no countdown.
 */
function minutesLeft(order: OrderRow, queue: QueueStatus): number {
  const since = order.queued_at ? new Date(order.queued_at).getTime() : null;
  if (!since) return queue.wait_minutes;
  return Math.ceil(queue.wait_minutes - (Date.now() - since) / 60_000);
}

function remaining(order: OrderRow, queue: QueueStatus): string {
  const left = minutesLeft(order, queue);
  if (left <= 0) return "Any moment now";
  if (left === 1) return "About a minute";
  return `About ${left} min`;
}

/**
 * The same estimate as a time of day.
 *
 * The countdown is what makes the capsule feel alive, so it stays — but you
 * plan around a clock, not a duration, and "ready by 3:40" is the difference
 * between waiting here and going to the next lecture. Dropped once the wait is
 * short enough that a time reads as false precision.
 */
function readyBy(order: OrderRow, queue: QueueStatus): string | null {
  const left = minutesLeft(order, queue);
  if (left < 3) return null;
  const at = new Date(Date.now() + left * 60_000);
  return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Progress is a real fraction where one exists — pages ahead vs pages
 * remaining — and a fixed step otherwise. It never animates on its own.
 */
/**
 * Where the fill sits along the five-stage track, as a percentage of the
 * distance between the first dot and the last. The dots are at 0, 25, 50, 75
 * and 100, so a stage's number lands exactly on its dot and the space between
 * two dots is real progress within a stage — queue position, mostly.
 */
function progressFor(order: OrderRow, queue: QueueStatus | null): number {
  switch (order.status) {
    case "placed":
      return 3;
    case "queued": {
      if (!queue || queue.pages_ahead + order.pages === 0) return 25;
      const share = queue.pages_ahead / (queue.pages_ahead + order.pages);
      return Math.round(25 + (1 - share) * 20);
    }
    case "printing":
      return 50;
    case "finishing":
      return 62;
    case "ready":
      return 75;
    case "delivering":
      return 88;
    case "collected":
      return 100;
    case "failed":
    case "cancelled":
      return stageReached(order) * 25;
    default:
      return 0;
  }
}

const STAGES = ["Placed", "Queued", "Printing", "Ready", "Collected"] as const;
/** The same five for a delivery (0046): the last stop is the door, not the counter. */
const DELIVERY_STAGES = ["Placed", "Queued", "Printing", "Ready", "Delivered"] as const;

/** The furthest stage this order got to — the timestamps say, not the status. */
function stageReached(order: OrderRow): number {
  if (order.status === "collected") return 4;
  if (order.status === "ready" || order.status === "delivering" || order.ready_at) return 3;
  if (order.status === "printing" || order.status === "finishing" || order.started_at) return 2;
  if (order.status === "queued" || order.queued_at) return 1;
  return 0;
}

/**
 * Five dots on a line, filled as far as the job has come.
 *
 * Replaces a bare 3px bar. The dots are the stages a student actually cares
 * about, so the same line now says both "how far" and "what's next". No
 * halo on the current dot: a solid dot with a knockout ring in the shell
 * colour separates it from the line without lighting it up.
 */
function StageTrack({
  order,
  fillRef,
  done,
  failed,
}: {
  order: OrderRow;
  fillRef: React.RefObject<HTMLSpanElement | null>;
  done: boolean;
  failed: boolean;
}) {
  const reached = stageReached(order);
  const tone = failed ? "bg-clay" : done ? "bg-sage" : "bg-shell-ink";
  const stages = order.delivery ? DELIVERY_STAGES : STAGES;

  return (
    <motion.div layout="position" className="mt-3.5">
      {/* The line runs from the first dot's centre to the last's. Each dot is
          centred in a fifth of the width, so labels line up beneath by
          sharing the same grid. */}
      <div className="relative mx-[10%] h-[7px]">
        <span className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-shell-line" />
        <span
          ref={fillRef}
          className={cn(
            "absolute top-1/2 left-0 h-[2px] w-0 -translate-y-1/2 rounded-full transition-colors duration-500",
            tone,
          )}
        />
        {stages.map((stage, i) => {
          const passed = i < reached || (i === reached && (done || failed));
          const current = i === reached && !done && !failed;
          return (
            <span
              key={stage}
              style={{ left: `${i * 25}%` }}
              className={cn(
                "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-500",
                current
                  ? cn("size-[9px] ring-2 ring-shell", tone)
                  : passed
                    ? cn("size-[7px]", tone)
                    : "size-[7px] border-[1.5px] border-shell-line bg-shell",
              )}
            />
          );
        })}
      </div>

      <div className="mt-1.5 grid grid-cols-5">
        {stages.map((stage, i) => (
          <span
            key={stage}
            className={cn(
              "text-center font-mono text-[9.5px] tracking-[0.02em] transition-colors duration-500",
              i === reached ? "text-shell-ink" : i < reached ? "text-shell-faint" : "text-shell-faint/60",
            )}
          >
            {stage}
          </span>
        ))}
      </div>
    </motion.div>
  );
}

/* ---------- pieces ---------- */

/** One Google button, drawn as an island row. */
function SignedOutIsland() {
  const { go, busy, error } = useGoogleSignIn("/");
  return (
    <IslandShell>
      <button onClick={() => void go()} disabled={busy} className="w-full text-left disabled:opacity-60">
        <IslandRow
          icon={
            busy ? (
              <Loader2 size={15} className="animate-spin text-shell-faint" />
            ) : (
              <LogIn size={15} strokeWidth={2.2} className="text-shell-faint" />
            )
          }
          title="Sign in with Google to track a job"
          sub={error ?? "Your orders are tied to your account"}
        />
      </button>
      <DeskShortcut />
    </IslandShell>
  );
}

/**
 * On a device paired to a desk, the student home is usually the wrong page
 * to be on. One line points the way. Only where both sites share a host —
 * on its own host the desk device would never be here.
 */
function DeskShortcut() {
  const { split } = useSurface();
  const [paired, setPaired] = useState(false);
  useEffect(() => setPaired(isPairedDevice()), []);
  if (split || !paired) return null;
  return (
    <Link
      href="/operator"
      className="mt-3 flex items-center gap-2 rounded-xl bg-shell-line px-3 py-2.5 text-[12.5px] font-semibold"
    >
      <MonitorSmartphone size={14} strokeWidth={2.2} className="text-shell-faint" />
      This is a desk device — start a shift
    </Link>
  );
}

function IslandShell({ children, open }: { children: React.ReactNode; open?: boolean }) {
  return (
    <div data-anim="island">
      <motion.div
        layout
        transition={spring}
        className={cn(
          "w-full overflow-hidden bg-shell px-4 py-[13px] text-shell-ink shadow-lift",
          open ? "rounded-[28px] pb-2.5" : "rounded-3xl",
        )}
      >
        {children}
      </motion.div>
    </div>
  );
}

function IslandRow({
  icon,
  title,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-[26px] shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight font-semibold tracking-[-0.01em]">
          {title}
        </span>
        <span className="mt-px block text-[12.5px] leading-snug text-shell-faint">{sub}</span>
      </span>
    </div>
  );
}

function IslandSkeleton() {
  return (
    <IslandShell>
      <IslandRow
        icon={<Loader2 size={15} className="animate-spin text-shell-faint" />}
        title="Checking the queue…"
        sub="Looking for an order in progress"
      />
    </IslandShell>
  );
}

function NoActiveOrder() {
  const openSheet = useApp((s) => s.openSheet);
  return (
    <IslandShell>
      <button onClick={() => openSheet("upload")} className="w-full text-left">
        <IslandRow
          icon={<span className="size-2 rounded-full bg-shell-faint" />}
          title="Nothing printing"
          sub="Upload a file and it'll show up here"
        />
      </button>
    </IslandShell>
  );
}

function Pulse({ done, failed }: { done: boolean; failed: boolean }) {
  return (
    <span className="relative grid size-[26px] shrink-0 place-items-center">
      {done || failed ? (
        <motion.i
          initial={{ rotate: -90, opacity: 0 }}
          animate={{ rotate: 0, opacity: 1 }}
          transition={spring}
          className={cn(
            "absolute inset-0.5 rounded-full border-2",
            failed ? "border-clay" : "border-sage",
          )}
        />
      ) : (
        <i className="absolute inset-0.5 animate-[spin_1s_linear_infinite] rounded-full border-2 border-shell-faint border-t-shell-ink" />
      )}
      <b
        className={cn(
          "size-2 rounded-full transition-colors duration-400",
          failed ? "bg-clay" : done ? "bg-sage" : "bg-shell-ink",
        )}
      />
    </span>
  );
}

function Timeline({ events, order }: { events: OrderEventRow[]; order: OrderRow }) {
  if (events.length === 0) {
    return <p className="mt-3 mb-1 text-[12.5px] text-shell-faint">No timeline entries yet.</p>;
  }

  return (
    <ul className="mt-3 flex list-none flex-col pb-1.5">
      {events.map((event, i) => {
        const current = i === events.length - 1 && event.status === order.status;
        return (
          <motion.li
            key={event.id}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.06 + i * 0.035, duration: 0.3, ease: easeIos }}
            className="relative flex items-start gap-[11px] py-1.5 text-[12.5px] text-shell-ink"
          >
            <span
              className={cn(
                "z-10 mt-[5px] shrink-0 rounded-full",
                current ? "size-[7px] bg-shell-ink ring-2 ring-shell" : "size-[7px] bg-sage",
              )}
            />
            {i < events.length - 1 && (
              <span className="absolute top-4 bottom-[-2px] left-[3px] w-px bg-shell-line" />
            )}
            <span className="min-w-0 flex-1">
              {event.note ?? STATUS_LABEL[event.status]}
            </span>
            <time className="ml-auto shrink-0 font-mono text-[11px] text-shell-faint">
              {new Date(event.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </time>
          </motion.li>
        );
      })}
    </ul>
  );
}

/**
 * The pickup code, as a QR.
 *
 * The operator scans it instead of asking for a name and searching — the
 * difference between a fifteen-second handover and a two-second one when there
 * is a queue behind you.
 */
function HandoverCode({
  token,
  code,
  operatorId,
}: {
  token: string;
  code: string | null;
  operatorId: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [shown, setShown] = useState(false);

  // What the code says. If any part of it changes — the secret arriving a
  // beat after the row, say — the image is drawn again rather than kept.
  const payload = `printify:order:${token}${code ? `:${code}` : ""}${
    code ? `:${operatorId.replace(/-/g, "").slice(0, 8).toUpperCase()}` : ""
  }`;

  useEffect(() => {
    setSrc(null);
  }, [payload]);

  useEffect(() => {
    if (!shown || src) return;
    let cancelled = false;
    void import("qrcode").then(({ default: QRCode }) =>
      // Token, the per-order secret, and the first eight characters of the
      // desk's id. The token alone is on every slip on the shelf and is
      // sequential; the secret is what makes this code yours; the desk is so
      // that a scanner at the wrong counter can say so instead of guessing.
      // Two modules of quiet zone and a generous raster: a phone camera at
      // arm's length reads a 200px code with room to spare, and jsQR wants the
      // white border.
      QRCode.toDataURL(payload, { margin: 2, width: 480, errorCorrectionLevel: "M" })
        .then((url) => !cancelled && setSrc(url))
        .catch(() => undefined),
    );
    return () => {
      cancelled = true;
    };
  }, [shown, src, payload]);

  return (
    <div className="mt-3">
      <button
        onClick={() => setShown((v) => !v)}
        className="h-11 w-full rounded-xl bg-shell-ink text-[14px] font-semibold text-shell"
      >
        {shown ? "Hide code" : "Show pickup code"}
      </button>

      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: easeIos }}
            className="overflow-hidden"
          >
            <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl bg-white p-3">
              {src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src} alt={`Pickup code ${token}`} className="size-[200px]" />
              ) : (
                <span className="grid size-[200px] place-items-center">
                  <Loader2 size={18} className="animate-spin text-[#17171a]" />
                </span>
              )}
              {/* The token, big enough to read across a counter (0044): the
                  cover sheet on the pile says the same, so saying it aloud
                  finds the paper; the code proves it's yours. */}
              <span className="font-figure text-[40px] leading-none font-extrabold tracking-[-0.01em] text-[#17171a]">
                {token}
              </span>
              <span className="text-[11px] text-[#6b6b70]">Say it, or show the code — the pile is labelled {token}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
