"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CreditCard, Loader2 } from "lucide-react";
import {
  awaitPaid,
  gatewayMode,
  launchHosted,
  openSession,
  takeFlight,
  warmCheckout,
  type OnlineOutcome,
  type OnlineSession,
} from "@/lib/gateway";
import { money } from "@/lib/pricing";

/**
 * Paying through Printifi: Cashfree's hosted checkout, in a modal over the
 * page. Two things happen the moment this opens so the tap is instant:
 * the server makes the session, and the SDK is loaded and constructed —
 * its checkout() waits on a ping the constructor starts, so constructed
 * here it has answered before the amount has been read.
 *
 * The tap itself hands the checkout to the flight (lib/gateway) and asks
 * the sheet to close: this sheet is a modal drawer, and while it's open
 * the page outside it — Cashfree's modal included — takes no taps. When
 * the checkout ends unpaid, the capsule reopens the sheet and this pane
 * starts with that outcome in hand. Paid needs no sheet: the row says so.
 * Nothing here can mark an order paid — Cashfree's webhook does.
 */
export function OnlinePay({
  orderId,
  amount,
  currency,
  onPaid,
  onCheckoutOpen,
}: {
  orderId: string;
  amount: number;
  currency: string;
  onPaid: () => void;
  /** The checkout is taking the screen; the sheet should get out of its way. */
  onCheckoutOpen: () => void;
}) {
  const [session, setSession] = useState<OnlineSession | null>(null);
  const [state, setState] = useState<"opening" | "ready" | "paying" | "checking" | OnlineOutcome>("opening");
  // A flight is handed over once; a second run of the effect (strict mode
  // in development) must not fetch a fresh session over the outcome.
  const tookFlight = useRef(false);
  // The sheet passes `onPaid` as a fresh arrow on every render. Read through
  // a ref so the effect below runs once per order, not once per render:
  // as a dependency it re-ran on every tick of the sheet — the desk row
  // arriving, the cash standing, the QR — and each run asked the server
  // for a session again. Several ran at once, each tried to make the same
  // Cashfree order, and the button showed whichever answered last: two or
  // three seconds, and sometimes "order with same id is already present".
  const paid = useRef(onPaid);
  // oxlint-disable-next-line react/refs -- the latest-value ref, read by callbacks that outlive this render
  paid.current = onPaid;

  useEffect(() => {
    let alive = true;
    const mode = gatewayMode();
    if (mode) warmCheckout(mode);

    // Back from a checkout that ended unpaid: its session is still live,
    // and its outcome is the first thing to say.
    const done = takeFlight(orderId);
    if (done) {
      tookFlight.current = true;
      setSession(done.session);
      setState(done.outcome ?? "ready");
      if (done.outcome?.kind === "paid") paid.current();
      return;
    }
    if (tookFlight.current) return;

    setState("opening");
    setSession(null);
    void openSession(orderId).then((r) => {
      if (!alive) return;
      if (r.kind === "session") {
        setSession(r.session);
        setState("ready");
      } else {
        setState(r);
        if (r.kind === "paid") paid.current();
      }
    });
    return () => {
      alive = false;
    };
  }, [orderId]);

  function finish(outcome: OnlineOutcome) {
    setState(outcome);
    if (outcome.kind === "paid") paid.current();
  }

  function pay() {
    if (!session) return;
    setState("paying");
    launchHosted(session, orderId);
    onCheckoutOpen();
  }

  async function recheck() {
    setState("checking");
    finish(await awaitPaid(orderId, 3));
  }

  const busy = state === "opening" || state === "paying" || state === "checking";
  const outcome = typeof state === "object" ? state : null;

  if (outcome?.kind === "needs-phone") {
    return (
      <p className="mb-4 rounded-[14px] border border-line bg-surface p-3.5 text-[12.5px] leading-relaxed text-clay-ink dark:text-clay">
        The payment partner needs a phone number on the order.{" "}
        <Link href="/settings" className="font-semibold underline underline-offset-2">Add yours in Settings</Link>, then come back.
      </p>
    );
  }
  if (outcome?.kind === "error" && !session) {
    return (
      <p className="mb-4 rounded-[14px] border border-line bg-surface p-3.5 text-[12.5px] leading-relaxed text-clay-ink dark:text-clay">
        {outcome.message}
      </p>
    );
  }

  return (
    <div className="mb-4">
      <button
        onClick={pay}
        disabled={busy || !session}
        className="flex h-[54px] w-full items-center justify-center gap-2.5 rounded-2xl bg-ink text-[15px] font-semibold text-paper disabled:opacity-60"
      >
        {busy ? <Loader2 size={17} className="animate-spin" /> : <CreditCard size={17} strokeWidth={2.2} />}
        {/* The amount is known before the session is: the button reads as
            itself from the first frame, and the spinner says it isn't live yet. */}
        {state === "paying"
          ? "Opening the checkout…"
          : state === "checking"
            ? "Checking…"
            : `Pay ${money(amount, currency)} · UPI, card`}
      </button>
      <p className="m-0 mt-2 text-[11px] leading-relaxed text-muted">
        Through Printifi&apos;s payment partner. Any UPI app, card or netbanking, amount filled in — confirmed the moment it
        lands, and the desk starts without checking anything.
      </p>
      {outcome?.kind === "pending" && (
        <p className="m-0 mt-2 text-[12px] leading-relaxed text-muted">
          Not confirmed yet. If you completed it, this order updates on its own within a minute;{" "}
          <button onClick={() => void recheck()} className="font-semibold underline underline-offset-2">check again</button>. If you
          didn&apos;t, nothing happens.
        </p>
      )}
      {outcome?.kind === "cancelled" && <p className="m-0 mt-2 text-[12px] text-muted">Nothing was charged.</p>}
      {outcome?.kind === "error" && session && (
        <p className="m-0 mt-2 text-[12px] leading-relaxed text-clay-ink dark:text-clay">{outcome.message}</p>
      )}
    </div>
  );
}
