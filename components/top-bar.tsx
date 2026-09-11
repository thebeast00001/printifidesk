"use client";

import Link from "next/link";
import { SignInButton, useAuth, useUser } from "@clerk/nextjs";
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "motion/react";
import { LogIn, MapPin, Search, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Container } from "./container";
import { useOperatorWait } from "@/hooks/use-tracking";
import { useApp } from "@/lib/store";
import { perPage, rateCardOf } from "@/lib/pricing";
import type { Operator, OperatorWait } from "@/lib/orders";
import { clockLabel, cn } from "@/lib/utils";

export function TopBar() {
  const { scrollY } = useScroll();
  const [pinned, setPinned] = useState(false);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const { operator, wait, ready } = useOperatorWait();

  return (
    <header
      data-anim="top"
      className={cn(
        "sticky top-0 z-30 border-b bg-paper/[0.88] backdrop-blur-xl backdrop-saturate-150",
        "transition-colors duration-300 lg:static lg:bg-transparent lg:backdrop-blur-none",
        pinned ? "border-line lg:border-transparent" : "border-transparent",
      )}
    >
      <Container className="pt-[max(16px,env(safe-area-inset-top))] pb-3 lg:pt-8 lg:pb-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
          <div className="min-w-0">
            <p className="label-caps mb-0.5 flex items-center gap-1.5">
              {ready && (
                <span
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    wait?.open ? "bg-sage" : "bg-clay",
                  )}
                />
              )}
              {!ready ? "Checking…" : <Status open={Boolean(wait?.open)} operator={operator} />}
            </p>

            <div className="flex items-start justify-between gap-3">
              <h1 className="font-heading m-0 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[32px] leading-[0.98] font-extrabold lg:text-[40px]">
                <Headline ready={ready} wait={wait} operator={operator} />
                {wait && wait.open && wait.pending_orders > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-[5px] text-[11px] leading-none font-semibold tracking-normal text-ink-soft">
                    {wait.pending_orders} in queue
                  </span>
                )}
              </h1>
              <div className="lg:hidden">
                <HeaderActions />
              </div>
            </div>

            <p className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-muted">
              <MapPin size={12} strokeWidth={2.2} />
              <span>
                PICKUP ·{" "}
                <b className="font-semibold text-ink-soft">
                  {operator?.name ?? "Not set up yet"}
                </b>
              </span>
            </p>
          </div>

          <div className="flex items-center gap-2.5 lg:shrink-0 lg:pb-1">
            <button
              onClick={() => setSearchOpen(true)}
              className="flex h-11 flex-1 items-center gap-2.5 rounded-[14px] border border-line bg-surface px-3.5 shadow-card transition-colors hover:bg-surface-sunk lg:w-[300px] lg:flex-none"
            >
              <Search size={15} strokeWidth={2.2} className="text-faint" />
              <span className="flex-1 text-left text-sm text-faint">
                Search <span className="font-medium text-ink-soft">files and orders</span>
              </span>
              <kbd className="hidden rounded border border-line bg-surface-sunk px-1.5 py-0.5 font-mono text-[10px] text-muted lg:block">
                ⌘K
              </kbd>
            </button>
            <div className="hidden lg:block">
              <HeaderActions />
            </div>
          </div>
        </div>
      </Container>

      <SubscribeToScroll onChange={setPinned} scrollY={scrollY} />
    </header>
  );
}

/**
 * When open, the headline is the real wait: pages actually queued divided by
 * this operator's configured throughput. With an empty queue there is nothing
 * to quote, so it says so rather than inventing a number.
 *
 * When closed — including when the backend can't be reached — a student is told
 * the one thing that affects them: orders aren't being taken. The technical
 * reason lives on /diagnostics, which is for whoever runs this.
 */
function Headline({
  ready,
  wait,
  operator,
}: {
  ready: boolean;
  wait: OperatorWait | null;
  operator: Operator | null;
}) {
  if (!ready) return <>Checking…</>;
  if (!wait?.open) return <>{operator?.status_note?.trim() || "Not taking orders"}</>;
  if (wait.pending_orders === 0 && operator) return <IdleHeadline wait={wait} operator={operator} />;
  return <>About {wait.wait_minutes} min</>;
}

/**
 * "Open now · till 8 PM" rather than "Printify open" — what a sign on the
 * door says. Hours are the operator's advertised ones; the switch still
 * decides whether the desk is open, and this only ever reports the switch.
 */
function Status({ open, operator }: { open: boolean; operator: Operator | null }) {
  if (open) {
    const till = clockLabel(operator?.closes_at);
    return <>Open now{till ? ` · till ${till}` : ""}</>;
  }
  const opens = clockLabel(operator?.opens_at);
  return <>Closed{opens ? ` · opens ${opens}` : ""}</>;
}


/**
 * With nothing in the queue there is no wait to quote, and "No queue right
 * now" said the same thing all afternoon. So the headline turns over every
 * few seconds through a handful of lines — each one a fact read from the
 * operator's own row, never a slogan. Stops turning when the tab is hidden,
 * and lands on the next line rather than restarting, so a glance always
 * catches something new.
 */
// Twenty seconds. Fast enough that a second glance catches a new line, slow
// enough that the heading doesn't feel like it's flickering at you.
const TURN_EVERY_MS = 20_000;

function IdleHeadline({ wait, operator }: { wait: OperatorWait; operator: Operator }) {
  const card = useMemo(() => rateCardOf(operator), [operator]);

  const lines = useMemo(() => {
    const out = ["No queue right now"];
    // An empty queue still takes the handling time; that is the honest "ready in".
    if (wait.wait_minutes > 0) out.push(`Ready in about ${wait.wait_minutes} min`);
    out.push(`B&W from ${perPage(card.bwPerPage, card.currency)}`);
    if (card.colourPerPage > card.bwPerPage) out.push("Colour where needed");
    const till = clockLabel(operator.closes_at);
    if (till) out.push(`Open till ${till}`);
    out.push("Print from your phone");
    return out;
  }, [wait.wait_minutes, card, operator.closes_at]);

  const [index, setIndex] = useState(0);

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      id = setInterval(() => setIndex((i) => (i + 1) % lines.length), TURN_EVERY_MS);
    };
    const stop = () => {
      if (id) clearInterval(id);
      id = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [lines.length]);

  const line = lines[index % lines.length];

  return (
    // popLayout, not wait: the leaving line is lifted out of flow while the
    // next one is already in it, so the heading never has an empty frame and
    // nothing below it jumps.
    <span className="relative inline-block">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={line}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
          className="inline-block"
        >
          {line}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * `<SignedIn>` / `<SignedOut>` were removed in Clerk Core 3 — they still appear
 * as exports but throw when rendered. In a client component `useAuth()` is the
 * direct replacement.
 */
function HeaderActions() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();

  // Reserve the space before Clerk resolves, so the header doesn't jump.
  if (!isLoaded) return <div className="size-11 shrink-0" aria-hidden />;

  if (!isSignedIn) {
    return (
      <SignInButton mode="modal">
        <button className="flex h-11 shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] font-semibold shadow-card transition-colors hover:bg-surface-sunk">
          <LogIn size={15} strokeWidth={2.2} />
          Sign in
        </button>
      </SignInButton>
    );
  }

  /* One account control, ours. Clerk's <UserButton> is deliberately not here —
     two avatars side by side is confusing; its account management is reached
     from inside /profile instead. */
  return (
    <motion.div whileTap={{ scale: 0.92 }} className="shrink-0">
      <Link
        href="/profile"
        aria-label="Your account"
        className="grid size-11 place-items-center overflow-hidden rounded-full border border-line bg-surface shadow-card transition-colors hover:bg-surface-sunk"
      >
        {user?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.imageUrl} alt="" className="size-full object-cover" />
        ) : (
          <User size={17} strokeWidth={2} />
        )}
      </Link>
    </motion.div>
  );
}

/** Kept out of the main body so the hook call stays above the early returns. */
function SubscribeToScroll({
  scrollY,
  onChange,
}: {
  scrollY: ReturnType<typeof useScroll>["scrollY"];
  onChange: (pinned: boolean) => void;
}) {
  useMotionValueEvent(scrollY, "change", (y) => onChange(y > 8));
  return null;
}
