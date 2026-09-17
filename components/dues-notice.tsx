"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { AnimatePresence, motion } from "motion/react";
import { Banknote, CreditCard, Loader2, QrCode } from "lucide-react";
import { useAuthKey } from "@/hooks/use-auth-key";
import { useChanged } from "@/lib/changed";
import { cashStanding, type CashStanding } from "@/lib/orders";
import { awaitDuesPaid, duesKey, gatewayMode, launchHosted, openDuesSession, takeFlight, useCheckoutFlight, type OnlineOutcome } from "@/lib/gateway";
import { money } from "@/lib/pricing";
import { cn, easeIos, spring } from "@/lib/utils";

/**
 * Dues (0043): what an uncollected cash order left on the account. While
 * there's anything here, no desk takes an order — so this sits at the top
 * of the home page and the orders page until it's paid, with the two ways
 * to pay: online through Printifi, or in cash at any desk, which scans
 * the code below.
 *
 * Every number is the database's: the amount, the limit, the strikes.
 */
export function DuesNotice() {
  const authKey = useAuthKey();
  const { userId } = useAuth();
  const version = useChanged("orders");
  const [standing, setStanding] = useState<CashStanding | null>(null);
  const [paying, setPaying] = useState(false);
  const [outcome, setOutcome] = useState<OnlineOutcome | null>(null);
  const [showCode, setShowCode] = useState(false);
  const flight = useCheckoutFlight();

  const load = useCallback(async () => {
    setStanding(await cashStanding());
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // The checkout ran outside this component; its outcome lands here.
  useEffect(() => {
    if (!flight || flight.phase !== "done" || !flight.orderId.startsWith("dues:")) return;
    const done = takeFlight(flight.orderId);
    if (!done) return;
    setPaying(false);
    setOutcome(done.outcome);
    if (done.outcome?.kind === "paid") void load();
  }, [flight, load]);

  async function payOnline() {
    setPaying(true);
    setOutcome(null);
    const r = await openDuesSession();
    if (r.kind !== "session") {
      setPaying(false);
      setOutcome(r);
      if (r.kind === "paid") void load();
      return;
    }
    launchHosted(r.session, duesKey(r.duesId));
  }

  async function recheck() {
    if (!flight?.orderId.startsWith("dues:")) return;
    setPaying(true);
    const r = await awaitDuesPaid(flight.orderId.slice("dues:".length), 3);
    setPaying(false);
    setOutcome(r);
    if (r.kind === "paid") void load();
  }

  const dues = standing?.dues ?? 0;
  const online = gatewayMode() !== null;

  return (
    <AnimatePresence initial={false}>
      {dues > 0 && (
        <motion.section
          key="dues"
          data-anim="dues"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.3, ease: easeIos }}
          className="rounded-[20px] border border-clay bg-surface p-4 shadow-card"
        >
          <p className="label-caps m-0 flex items-center gap-1.5 text-clay-ink dark:text-clay">
            <Banknote size={12} strokeWidth={2.4} />
            Dues
          </p>
          <p className="font-heading m-0 mt-1 text-[22px] font-bold tracking-[-0.01em]">{money(dues)} due</p>
          <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">
            From a cash order that wasn&apos;t collected — Printifi paid the desk for it. Ordering is paused at every desk
            until it&apos;s settled.
            {standing?.strikes === 1 ? " One more uncollected order switches cash off for your account." : ""}
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            {online && (
              <motion.button
                whileTap={{ scale: 0.98 }}
                transition={spring}
                disabled={paying}
                onClick={() => void payOnline()}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[13.5px] font-semibold text-paper disabled:opacity-60 sm:flex-1"
              >
                {paying ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} strokeWidth={2.2} />}
                Pay {money(dues)} online
              </motion.button>
            )}
            <motion.button
              whileTap={{ scale: 0.98 }}
              transition={spring}
              onClick={() => setShowCode((v) => !v)}
              className={cn(
                "flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface text-[13.5px] font-semibold text-ink-soft sm:flex-1",
                showCode && "bg-surface-sunk",
              )}
            >
              <QrCode size={14} strokeWidth={2.2} />
              {showCode ? "Hide the code" : "Pay cash at any desk"}
            </motion.button>
          </div>

          {outcome && outcome.kind !== "paid" && (
            <p className="m-0 mt-2 text-[12px] leading-relaxed text-clay-ink dark:text-clay">
              {outcome.kind === "cancelled" && "Nothing was charged."}
              {outcome.kind === "pending" && (
                <>
                  Still waiting for the bank.{" "}
                  <button onClick={() => void recheck()} className="font-semibold underline underline-offset-2">Check again</button>
                </>
              )}
              {outcome.kind === "error" && outcome.message}
              {outcome.kind === "needs-phone" && "The payment partner needs a phone number — add yours in Settings."}
            </p>
          )}

          <AnimatePresence initial={false}>
            {showCode && userId && (
              <motion.div
                key="code"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: easeIos }}
                className="overflow-hidden"
              >
                <DuesCode userId={userId} amount={dues} />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

/** The code a desk scans to take the dues in cash: who, so the desk's app can look up how much. */
function DuesCode({ userId, amount }: { userId: string; amount: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const payload = `printify:dues:${userId}`;
  useEffect(() => {
    let cancelled = false;
    void import("qrcode").then(({ default: QRCode }) =>
      QRCode.toDataURL(payload, { margin: 2, width: 480, errorCorrectionLevel: "M" })
        .then((url) => !cancelled && setSrc(url))
        .catch(() => undefined),
    );
    return () => {
      cancelled = true;
    };
  }, [payload]);
  return (
    <div className="mt-3 flex items-center gap-3.5 rounded-[14px] bg-surface-sunk p-3">
      <div className="size-[104px] shrink-0 overflow-hidden rounded-lg bg-white p-1">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="Your dues code" className="size-full" />
        ) : (
          <div className="flex size-full items-center justify-center"><Loader2 size={16} className="animate-spin text-faint" /></div>
        )}
      </div>
      <p className="m-0 text-[12.5px] leading-relaxed text-muted">
        Show this at the counter of any Printifi desk and pay <b className="font-semibold text-ink">{money(amount)}</b> in cash. The desk scans it and
        your account opens again straight away.
      </p>
    </div>
  );
}
