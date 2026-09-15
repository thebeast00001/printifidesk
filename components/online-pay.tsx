"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CreditCard, Loader2 } from "lucide-react";
import { awaitPaid, openSession, payHosted, type OnlineOutcome, type OnlineSession } from "@/lib/gateway";
import { money } from "@/lib/pricing";

/**
 * Paying through Printify: Cashfree's hosted checkout, in a modal over the
 * sheet. The session is made the moment the sheet opens so the tap opens
 * the checkout at once; closing the modal without paying comes straight
 * back here. Nothing here can mark an order paid — Cashfree's webhook
 * does — but after the modal closes the server is asked, so the sheet can
 * close on "paid" without waiting for it.
 */
export function OnlinePay({
  orderId,
  amount,
  currency,
  onPaid,
}: {
  orderId: string;
  amount: number;
  currency: string;
  onPaid: () => void;
}) {
  const [session, setSession] = useState<OnlineSession | null>(null);
  const [state, setState] = useState<"opening" | "ready" | "paying" | "checking" | OnlineOutcome>("opening");

  useEffect(() => {
    let alive = true;
    setState("opening");
    setSession(null);
    void openSession(orderId).then((r) => {
      if (!alive) return;
      if (r.kind === "session") {
        setSession(r.session);
        setState("ready");
      } else {
        setState(r);
        if (r.kind === "paid") onPaid();
      }
    });
    return () => {
      alive = false;
    };
  }, [orderId, onPaid]);

  function finish(outcome: OnlineOutcome) {
    setState(outcome);
    if (outcome.kind === "paid") onPaid();
  }

  async function pay() {
    if (!session) return;
    setState("paying");
    finish(await payHosted(session, orderId));
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
        onClick={() => void pay()}
        disabled={busy || !session}
        className="flex h-[54px] w-full items-center justify-center gap-2.5 rounded-2xl bg-ink text-[15px] font-semibold text-paper disabled:opacity-60"
      >
        {busy ? <Loader2 size={17} className="animate-spin" /> : <CreditCard size={17} strokeWidth={2.2} />}
        {state === "opening"
          ? "Getting ready…"
          : state === "paying"
            ? "Finish in the checkout…"
            : state === "checking"
              ? "Checking…"
              : `Pay ${money(amount, currency)} · UPI, card`}
      </button>
      <p className="m-0 mt-2 text-[11px] leading-relaxed text-muted">
        Through Printify&apos;s payment partner. Any UPI app, card or netbanking, amount filled in — confirmed the moment it
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
