"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { SignInButton } from "@clerk/nextjs";
import { AlertCircle, Flag, Loader2, LogIn, RotateCcw } from "lucide-react";
import { useActiveOrder } from "@/hooks/use-tracking";
import { STATUS_LABEL, type OrderEventRow, type OrderRow, type QueueStatus } from "@/lib/orders";
import { money } from "@/lib/pricing";
import { useApp } from "@/lib/store";
import type { ConnectionState } from "@/lib/realtime";
import { PaySheet } from "./pay-sheet";
import { ReportSheet } from "./report-sheet";
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

  if (backend.state === "loading") return <IslandSkeleton />;

  if (backend.state === "signed-out") {
    return (
      <IslandShell>
        <SignInButton mode="modal">
          <button className="w-full text-left">
            <IslandRow
              icon={<LogIn size={15} strokeWidth={2.2} className="text-shell-faint" />}
              title="Sign in to track a job"
              sub="Your orders are tied to your account"
            />
          </button>
        </SignInButton>
      </IslandShell>
    );
  }

  if (backend.state === "unconfigured" || backend.state === "error") {
    return (
      <IslandShell>
        <IslandRow
          icon={<AlertCircle size={16} strokeWidth={2.2} className="text-clay" />}
          title="Can't reach Printify"
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
}) {
  const barRef = useRef<HTMLSpanElement>(null);
  const [, tick] = useState(0);
  const progress = progressFor(order, queue);

  // The estimate is derived from elapsed time, so it needs a heartbeat.
  useEffect(() => {
    if (order.status !== "queued") return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [order.status]);
  const done = order.status === "ready" || order.status === "collected";
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

      {order.status === "ready" && order.token && <HandoverCode token={order.token} />}

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

      {order.status === "placed" && !order.payment_claimed_at && (
        <motion.button
          layout="position"
          whileTap={{ scale: 0.98 }}
          onClick={onPay}
          className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-shell-ink text-[14px] font-semibold text-shell"
        >
          Pay now
        </motion.button>
      )}

      <motion.span
        layout="position"
        className="mt-[11px] block h-[3px] overflow-hidden rounded-sm bg-shell-line"
      >
        <span
          ref={barRef}
          className={cn(
            "block h-[3px] w-0 rounded-sm transition-colors duration-500",
            failed ? "bg-clay" : done ? "bg-sage" : "bg-shell-ink",
          )}
        />
      </motion.span>

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
  return STATUS_LABEL[order.status];
}

function detail(order: OrderRow, queue: QueueStatus | null): string {
  const sheets = `${order.pages} ${order.pages === 1 ? "page" : "pages"}`;

  switch (order.status) {
    case "placed":
      return order.payment_claimed_at
        ? `${sheets} · waiting for the operator to confirm`
        : `${sheets} · pay to join the queue`;
    case "queued": {
      if (!queue) return sheets;
      const by = readyBy(order, queue);
      return [
        remaining(order, queue),
        by ? `ready by ${by}` : null,
        `${queue.pages_ahead} pages ahead of you`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "printing":
    case "finishing":
      return `${sheets} · ${order.config?.sides === "double" ? "both sides" : "one side"}`;
    case "ready":
      return order.token ? `Show token ${order.token} to collect` : "Waiting for you to collect";
    case "collected":
      return `${sheets} · collected`;
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
function progressFor(order: OrderRow, queue: QueueStatus | null): number {
  switch (order.status) {
    case "placed":
      return 6;
    case "queued": {
      if (!queue || queue.pages_ahead + order.pages === 0) return 20;
      const share = queue.pages_ahead / (queue.pages_ahead + order.pages);
      return Math.round(15 + (1 - share) * 25);
    }
    case "printing":
      return 65;
    case "finishing":
      return 85;
    case "ready":
    case "collected":
      return 100;
    case "failed":
    case "cancelled":
      return 100;
    default:
      return 0;
  }
}

/* ---------- pieces ---------- */

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
                "z-10 mt-[5px] size-[7px] shrink-0 rounded-full",
                current ? "bg-shell-ink ring-3 ring-shell-ink/25" : "bg-sage",
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
function HandoverCode({ token }: { token: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!shown || src) return;
    let cancelled = false;
    void import("qrcode").then(({ default: QRCode }) =>
      QRCode.toDataURL(`printify:order:${token}`, { margin: 1, width: 420 })
        .then((url) => !cancelled && setSrc(url))
        .catch(() => undefined),
    );
    return () => {
      cancelled = true;
    };
  }, [shown, src, token]);

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
                <img src={src} alt={`Pickup code ${token}`} className="size-[180px]" />
              ) : (
                <span className="grid size-[180px] place-items-center">
                  <Loader2 size={18} className="animate-spin text-[#17171a]" />
                </span>
              )}
              <span className="font-mono text-[15px] font-medium tracking-widest text-[#17171a]">
                {token}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
