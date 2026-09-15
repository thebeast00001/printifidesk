"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { AtSign, CreditCard, Loader2, QrCode } from "lucide-react";
import {
  CASHFREE_APPS,
  awaitPaid,
  openSession,
  payHosted,
  payWithElement,
  sdk,
  type CashfreeElement,
  type OnlineOutcome,
  type OnlineSession,
} from "@/lib/gateway";
import { useInstall } from "@/lib/install";
import { isValidVpa, normaliseVpa, vpaProblem } from "@/lib/upi";
import { money } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * Paying through Printify without leaving the sheet.
 *
 * The session is made the moment the sheet opens, so the buttons are live
 * by the time a thumb reaches them. On a phone, each UPI app is one of
 * Cashfree's own `upiApp` elements: the tap opens that app with an intent
 * Cashfree signed — amount filled in, every app accepts it, no hosted page
 * in between — and when the student comes back the server is asked
 * whether it landed. *Pay by UPI id* is Cashfree's collect element: a
 * request pushed to the student's own app. On a laptop, Cashfree's QR
 * (`upiQr`) carries the amount and any app reads it. *Card or netbanking*
 * is the hosted checkout in a modal, which is also where anything that
 * can't mount (an in-app browser, an old WebView) falls back to.
 *
 * Nothing here can mark an order paid. Cashfree's webhook does that; the
 * poll only asks sooner.
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
  const { platform, ready: platformReady } = useInstall();
  const onPhone = platformReady && platform !== "desktop";
  const [session, setSession] = useState<OnlineSession | null>(null);
  const [state, setState] = useState<"opening" | "ready" | "paying" | "checking" | OnlineOutcome>("opening");
  const [collectId, setCollectId] = useState("");
  const [elementsFailed, setElementsFailed] = useState(false);

  // The session, as soon as we know which order.
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

  async function withElement(make: (cf: Awaited<ReturnType<typeof sdk>>) => CashfreeElement) {
    if (!session) return;
    setState("paying");
    try {
      const cf = await sdk(session.mode);
      const element = make(cf);
      const outcome = await payWithElement(cf, element, session, orderId);
      finish(outcome);
    } catch (e) {
      finish({ kind: "error", message: e instanceof Error ? e.message : "The payment didn't start." });
    }
  }

  async function hosted() {
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

  return (
    <div className="mb-4">
      {outcome?.kind === "needs-phone" ? (
        <p className="m-0 rounded-[14px] border border-line bg-surface p-3.5 text-[12.5px] leading-relaxed text-clay-ink dark:text-clay">
          The payment partner needs a phone number on the order.{" "}
          <Link href="/settings" className="font-semibold underline underline-offset-2">Add yours in Settings</Link>, then come back.
        </p>
      ) : outcome?.kind === "error" && !session ? (
        <p className="m-0 rounded-[14px] border border-line bg-surface p-3.5 text-[12.5px] leading-relaxed text-clay-ink dark:text-clay">
          {outcome.message}
        </p>
      ) : (
        <>
          {onPhone && !elementsFailed ? (
            <>
              <p className="m-0 mb-2 text-[12px] font-semibold">Pay {money(amount, currency)} with</p>
              <div className="grid grid-cols-3 gap-2">
                {CASHFREE_APPS.map((app) => (
                  <AppButton
                    key={app.id}
                    session={session}
                    app={app.id}
                    label={app.label}
                    disabled={busy}
                    onPay={(make) => void withElement(make)}
                    onCannotMount={() => setElementsFailed(true)}
                  />
                ))}
              </div>
            </>
          ) : session && !onPhone ? (
            <QrPane session={session} orderId={orderId} amount={amount} currency={currency} onOutcome={finish} onCannotMount={() => setElementsFailed(true)} />
          ) : null}

          {/* UPI id: a collect request to the student's own app. */}
          {session && !elementsFailed && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const id = normaliseVpa(collectId);
                if (!isValidVpa(id) || !session) return;
                void withElement((cf) => cf.create("upiCollect", { values: { upiId: id } }));
              }}
              className="mt-2.5 flex gap-2"
            >
              <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface px-3">
                <AtSign size={14} strokeWidth={2.2} className="shrink-0 text-faint" />
                <input
                  value={collectId}
                  onChange={(e) => setCollectId(e.target.value)}
                  placeholder="Or your UPI id — a request comes to your app"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  className="h-11 min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-faint"
                />
              </label>
              <button
                type="submit"
                disabled={busy || !isValidVpa(collectId)}
                className="h-11 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-40"
              >
                Request
              </button>
            </form>
          )}
          {collectId.trim() && vpaProblem(collectId) && (
            <p className="m-0 mt-1 text-[11px] text-clay-ink dark:text-clay">{vpaProblem(collectId)}</p>
          )}

          <button
            onClick={() => void hosted()}
            disabled={busy || !session}
            className="mt-2.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface text-[13px] font-semibold text-ink-soft disabled:opacity-50"
          >
            {state === "opening" ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} strokeWidth={2.2} />}
            {state === "opening" ? "Getting ready…" : elementsFailed || (!onPhone && !session) ? "Pay · UPI, card, netbanking" : "Card or netbanking"}
          </button>

          {state === "paying" && (
            <p className="m-0 mt-2 flex items-center gap-2 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" />
              Finish in your app — this updates the moment the money lands.
            </p>
          )}
          {state === "checking" && (
            <p className="m-0 mt-2 flex items-center gap-2 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" />
              Checking with the payment partner…
            </p>
          )}
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
          <p className="m-0 mt-2 text-[11px] leading-relaxed text-muted">
            Through Printify&apos;s payment partner. Confirmed the moment it lands — the desk starts without checking anything.
          </p>
        </>
      )}
    </div>
  );
}

/** A div React never touches, under a frame React owns, for the SDK to mount into. */
function plainHost(frame: HTMLElement, id: string): HTMLDivElement {
  const existing = frame.querySelector<HTMLDivElement>(`#${CSS.escape(id)}`);
  if (existing) return existing;
  const host = document.createElement("div");
  host.id = id;
  host.style.width = "100%";
  host.style.height = "100%";
  frame.appendChild(host);
  return host;
}

/**
 * One of Cashfree's `upiApp` elements, mounted into our own button frame.
 * The element draws the app's mark and handles the tap; we answer the tap
 * with pay(). Until the session exists the frame is drawn disabled, so
 * the layout never jumps.
 */
function AppButton({
  session,
  app,
  label,
  disabled,
  onPay,
  onCannotMount,
}: {
  session: OnlineSession | null;
  app: (typeof CASHFREE_APPS)[number]["id"];
  label: string;
  disabled: boolean;
  onPay: (make: (cf: Awaited<ReturnType<typeof sdk>>) => CashfreeElement) => void;
  onCannotMount: () => void;
}) {
  // The SDK serialises the node it mounts into, and a React-owned node
  // carries a circular fiber — so it gets a plain div made outside React,
  // appended under our frame and named by id.
  const frame = useRef<HTMLDivElement>(null);
  const hostId = `cf-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-${app}`;
  const [mounted, setMounted] = useState(false);
  const elementRef = useRef<CashfreeElement | null>(null);

  useEffect(() => {
    if (!session || !frame.current) return;
    let alive = true;
    const host = plainHost(frame.current, hostId);
    void sdk(session.mode)
      .then((cf) => {
        if (!alive) return;
        const element = cf.create("upiApp", { values: { upiApp: app, buttonText: label, buttonIcon: true } });
        element.on("loaderror", () => alive && onCannotMount());
        element.on("click", () => onPay(() => element));
        elementRef.current = element;
        element.mount(`#${hostId}`);
        // Shown as soon as it's in the frame; a loaderror (a laptop, an
        // in-app browser) takes the whole row down and the modal steps in.
        if (alive) setMounted(true);
      })
      .catch(() => alive && onCannotMount());
    return () => {
      alive = false;
      try {
        elementRef.current?.unmount?.();
      } catch {
        /* already gone */
      }
      host.remove();
    };
    // Mount once per session; label/app never change for a mounted button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.paymentSessionId]);

  return (
    <div
      className={cn(
        "relative flex h-[56px] items-center justify-center overflow-hidden rounded-2xl border border-line bg-surface",
        (disabled || !mounted) && "opacity-60",
      )}
    >
      {!mounted && <span className="text-[13px] font-semibold text-muted">{label}</span>}
      <div ref={frame} className={cn("absolute inset-0 [&>*]:h-full [&>*]:w-full [&>*>*]:h-full [&>*>*]:w-full", !mounted && "opacity-0")} />
    </div>
  );
}

/** Cashfree's QR for a laptop: the amount is in it and any app reads it. Waits for the payment to land. */
function QrPane({
  session,
  orderId,
  amount,
  currency,
  onOutcome,
  onCannotMount,
}: {
  session: OnlineSession;
  orderId: string;
  amount: number;
  currency: string;
  onOutcome: (o: OnlineOutcome) => void;
  onCannotMount: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const hostId = `cf-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-qr`;
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!frame.current) return;
    let alive = true;
    const host = plainHost(frame.current, hostId);
    void sdk(session.mode)
      .then(async (cf) => {
        if (!alive) return;
        const qr = cf.create("upiQr", { values: { size: "220px" } });
        qr.on("loaderror", () => alive && onCannotMount());
        qr.mount(`#${hostId}`);
        // pay() with the QR element draws the code and resolves when the
        // payment is made or the code expires.
        setShown(true);
        const outcome = await payWithElement(cf, qr, session, orderId);
        if (alive) onOutcome(outcome);
      })
      .catch(() => alive && onCannotMount());
    return () => {
      alive = false;
      host.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.paymentSessionId]);

  return (
    <div className="flex flex-col items-center gap-2 rounded-[16px] border border-line bg-surface p-4">
      <p className="m-0 flex items-center gap-1.5 text-[12.5px] font-semibold">
        <QrCode size={14} strokeWidth={2.2} />
        Scan to pay {money(amount, currency)}
      </p>
      <div ref={frame} className="min-h-[220px] min-w-[220px]" />
      {!shown && (
        <p className="m-0 flex items-center gap-2 text-[12px] text-muted">
          <Loader2 size={13} className="animate-spin" />
          Drawing the code…
        </p>
      )}
      <p className="m-0 text-[11.5px] text-muted">Any UPI app. The amount is in the code.</p>
    </div>
  );
}
