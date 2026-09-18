"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import QRCode from "qrcode";
import { AlertCircle, Banknote, Check, Copy, Loader2, Smartphone } from "lucide-react";
import {
  cashLegacy,
  cashStanding,
  chooseCash,
  getOperator,
  peekCashStanding,
  peekOperator,
  type CashStanding,
  type Operator,
  type OrderRow,
} from "@/lib/orders";
import { getSupabase } from "@/lib/supabase/client";
import { UPI_APPS, appLink, isQrOnlyMerchant, isValidVpa, upiLink, type UpiRequest } from "@/lib/upi";
import { useInstall } from "@/lib/install";
import { canPayOnline, gatewayMode, warmCheckout } from "@/lib/gateway";
import { changed } from "@/lib/changed";
import { OnlinePay } from "./online-pay";
import { money } from "@/lib/pricing";
import { cn, spring } from "@/lib/utils";

/** A QR, drawn once per text and kept: the same link opens the same sheet many times in a day. */
const qrCache = new Map<string, Promise<string>>();
function qrFor(source: string): Promise<string> {
  let hit = qrCache.get(source);
  if (!hit) {
    hit = QRCode.toDataURL(source, { margin: 1, width: 480, errorCorrectionLevel: "M" });
    hit.catch(() => qrCache.delete(source));
    qrCache.set(source, hit);
    // A handful of links is plenty; the map mustn't grow with a day's orders.
    if (qrCache.size > 12) qrCache.delete(qrCache.keys().next().value!);
  }
  return hit;
}

/**
 * Paying for an order.
 *
 * A `upi://pay` link with the amount and the order token already in it, so the
 * student taps once and their own UPI app opens ready to send. Nothing sits in
 * the middle — the money goes to the operator's id directly.
 *
 * That pre-filled amount is only allowed when the desk's id is a merchant
 * one (the id behind its business QR). For a personal id the apps refuse
 * such a link outright, so the sheet turns into what does work everywhere:
 * copy the id, open the app, pay to it, type the amount — with the amount
 * and the token a tap away so nothing has to be remembered.
 *
 * What this deliberately does *not* do is claim the payment succeeded. Without
 * a gateway webhook nobody here can know that. "I've paid" records a claim the
 * operator can see; the operator confirms it against their own app.
 */
export function PaySheet({
  order,
  open,
  onOpenChange,
  onClaimed,
}: {
  order: OrderRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClaimed: () => void;
}) {
  /*
   * Whole from the first frame. This sheet is mounted, closed, under the
   * capsule from the moment there's an order — so everything it will show
   * is asked for then, and read synchronously at open: the desk's row
   * (warmed by the capsule; `peekOperator`), the cash standing (kept from
   * the last answer; `peekCashStanding`), the QR (drawn once per link,
   * kept). Before this, every open started from nothing — the row a tick
   * later, "Checking your cash limit…" becoming the real label a round trip
   * later, the QR after that — and each answer re-laid the sheet out while
   * it was still sliding up. Now the open is one paint and a slide, and the
   * standing refreshes behind it without blanking what's on screen.
   */
  const [operator, setOperator] = useState<Operator | null>(() => (order ? peekOperator(order.operator_id) : null));
  const [busy, setBusy] = useState<"upi" | "cash" | null>(null);
  // 0043: cash is a credit line — the database says whether, and how much.
  const [standing, setStanding] = useState<CashStanding | null>(() => peekCashStanding());
  const [legacy, setLegacy] = useState(() => cashLegacy());
  // What their app's success screen showed. Pre-filled with the bill; a
  // different number is a warning now instead of a surprise at the counter.
  const [sent, setSent] = useState(() => (order ? Number(order.total).toFixed(2) : ""));
  const [error, setError] = useState<string | null>(null);

  // While closed: have the desk's row and the standing in hand for the tap.
  const orderId = order?.id ?? null;
  const operatorId = order?.operator_id ?? null;
  useEffect(() => {
    if (!operatorId) return;
    let alive = true;
    setOperator(peekOperator(operatorId));
    void getOperator(operatorId).then((op) => alive && setOperator(op));
    void cashStanding().then((st) => {
      if (!alive) return;
      if (st) setStanding(st);
      setLegacy(cashLegacy());
    });
    return () => {
      alive = false;
    };
  }, [orderId, operatorId]);

  // At open: a clean slate for what the student types, and the standing
  // asked for again — kept on screen as it was until the answer differs.
  useEffect(() => {
    if (!open || !order) return;
    let alive = true;
    setError(null);
    setSent(Number(order.total).toFixed(2));
    void cashStanding().then((st) => {
      if (!alive) return;
      if (st) setStanding(st);
      setLegacy(cashLegacy());
    });
    return () => {
      alive = false;
    };
  }, [open, order]);

  // The row is live. When the money is confirmed — Cashfree's webhook, or
  // the desk taking a direct payment — while this is open, there is
  // nothing left to do here; it closes on its own instead of asking the
  // student to say they paid.
  useEffect(() => {
    if (!open || !order?.payment_taken_at) return;
    onClaimed();
    onOpenChange(false);
  }, [open, order?.payment_taken_at, onClaimed, onOpenChange]);

  const merchant = operator?.upi_kind === "merchant";
  // A Paytm merchant id: nothing but its own signed QR is accepted, so that
  // is what's drawn, and the link is not offered as if it might work.
  const qrOnly = Boolean(operator?.upi_vpa && isQrOnlyMerchant(operator.upi_vpa, operator.upi_kind ?? "personal"));
  const shopQr = qrOnly && operator?.upi_qr ? operator.upi_qr : null;
  const request = useMemo<UpiRequest | null>(() => {
    if (!order || !operator?.upi_vpa || !isValidVpa(operator.upi_vpa)) return null;
    return {
      vpa: operator.upi_vpa,
      payeeName: operator.upi_name?.trim() || operator.short_name || operator.name,
      // A personal id can't take the amount in the link; the payer types it.
      // A QR-only merchant id takes nothing but its standee, so Printifi's
      // copy carries no amount either — the closest thing to the standee.
      amount:
        operator.upi_kind === "merchant" && !isQrOnlyMerchant(operator.upi_vpa, "merchant")
          ? Number(order.total)
          : undefined,
      note: `Printifi ${order.token ?? ""}`.trim(),
      // Token plus the order's first hex so two B66s on different days differ.
      reference: `${order.token ?? ""}${order.id.replace(/-/g, "").slice(0, 8)}`,
    };
  }, [order, operator]);

  const link = request ? upiLink(request) : null;
  const amountText = order ? Number(order.total).toFixed(2) : "";
  // Which schemes to hand out: a phone gets its apps by name; a laptop scans.
  const { platform, ready: platformReady } = useInstall();
  const onPhone = platformReady && platform !== "desktop";
  const appPlatform = platform === "ios" ? "ios" : "android";
  const [copiedWhat, setCopiedWhat] = useState<"id" | "amount" | null>(null);
  async function copy(what: "id" | "amount", text: string) {
    await navigator.clipboard?.writeText(text);
    setCopiedWhat(what);
    setTimeout(() => setCopiedWhat(null), 1600);
  }

  // Drawn while the sheet is still closed (the desk's row is known then),
  // and only where it's shown: where Printifi collects, the direct route
  // isn't offered and the work — tens of milliseconds on the main thread —
  // would land in the middle of the slide for nothing.
  const gatewayDesk = canPayOnline(operator);
  // Cashfree's script and its ping iframe, loaded while the sheet is still
  // closed — at open they were loading under the slide.
  useEffect(() => {
    const mode = gatewayMode();
    if (gatewayDesk && mode) warmCheckout(mode);
  }, [gatewayDesk]);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    const source = gatewayDesk ? null : (shopQr ?? link);
    if (!source) return setQr(null);
    let alive = true;
    // Rendered locally — the payment link never leaves the device. The shop's
    // own QR is redrawn from its exact text, signature included.
    void qrFor(source)
      .then((url) => alive && setQr(url))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [link, shopQr, gatewayDesk]);

  // Cash: the platform checks the student's standing and decides whether
  // the desk prints now (within the limit) or when they set off (above it).
  const takeCash = useCallback(async () => {
    if (!order) return;
    setBusy("cash");
    setError(null);
    try {
      await chooseCash(order.id);
      onClaimed();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't choose cash.");
    } finally {
      setBusy(null);
    }
  }, [order, onClaimed, onOpenChange]);

  const claim = useCallback(
    async (method: "upi" | "cash") => {
      if (!order) return;
      if (method === "cash") return takeCash();
      setBusy(method);
      setError(null);
      const supabase = getSupabase();
      const { error: writeError } = await supabase!
        .from("orders")
        .update({
          payment_method: method,
          payment_claimed_at: new Date().toISOString(),
          // The desk checks a direct payment by the amount and the note (the
          // token), against its own app — nothing else is asked for.
          payment_reference: null,
          payment_claimed_amount:
            method === "upi" && sent.trim() !== "" && Number.isFinite(Number(sent)) ? Number(sent) : null,
        })
        .eq("id", order.id);
      setBusy(null);

      if (writeError) {
        setError(writeError.message);
        return;
      }
      changed("orders");
      onClaimed();
      onOpenChange(false);
    },
    [order, sent, onClaimed, onOpenChange, takeCash],
  );

  // What the cash button says: the limit, or why not.
  const total = order ? Number(order.total) : 0;
  const cash = (() => {
    if (operator?.accepts_cash === false) return null;
    // A project without 0043: the button as it always was.
    if (!standing && legacy) return { ok: true, label: "I'll pay cash at the desk", hint: "The desk confirms it at the counter before printing.", disabled: false };
    if (!standing) return { ok: false, label: "Cash at the counter", hint: "Checking your cash limit…", disabled: true };
    if (standing.reason === "dues")
      return { ok: false, label: "Cash at the counter", hint: `₹${standing.dues.toFixed(0)} is due from an uncollected order — pay it first (it's on your home page).`, disabled: true };
    if (standing.reason === "blocked")
      return { ok: false, label: "Cash at the counter", hint: `Cash is off for your account until ${standing.blocked_until ? new Date(standing.blocked_until).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "later"} — two orders went uncollected. UPI works as usual.`, disabled: true };
    if (standing.reason === "open")
      return { ok: false, label: "Cash at the counter", hint: `Collect your other cash order${standing.open_cash_token ? ` (${standing.open_cash_token})` : ""} first — one at a time.`, disabled: true };
    // A delivery (0046): the runner is the one who sets off, so there's no
    // "leaving now" — it queues at once and the cash changes hands at the door.
    if (order?.delivery)
      return { ok: true, label: `Pay ${money(total, operator?.currency)} cash at my door`, hint: "Printed now; Printifi's runner takes the cash when it's delivered. An order you don't take becomes dues on your account, like any cash order.", disabled: false };
    if (total <= standing.cash_limit)
      return { ok: true, label: `Pay ${money(total, operator?.currency)} cash when I collect`, hint: `Printed now, paid at the counter. Your cash limit is ${money(standing.cash_limit, operator?.currency)} — it grows each time you collect.`, disabled: false };
    return { ok: true, label: "Cash — printed when I set off", hint: `Above your ${money(standing.cash_limit, operator?.currency)} cash limit, so the desk prints when you tap "Leaving now" — it's ready by the time you arrive. Pay online to have it printed right away.`, disabled: false };
  })();

  const sentValue = Number(sent);
  const sentDiff =
    order && sent.trim() !== "" && Number.isFinite(sentValue)
      ? Math.round((sentValue - Number(order.total)) * 100) / 100
      : 0;

  const claimed = Boolean(order?.payment_claimed_at);
  // Where Printifi collects, the two ways are online and cash: a transfer
  // to the desk's own UPI id isn't offered beside a checkout that confirms
  // itself — it would be a second, slower way to do the same thing, and
  // the one the desk has to check by hand. Everywhere else the direct
  // route is the online route.
  const gateway = gatewayDesk;
  const direct = Boolean(operator) && !gateway;

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.45)] backdrop-blur-[3px]" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-80 mx-auto flex max-h-[92dvh] w-full max-w-[520px] flex-col
                     rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]"
        >
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <Drawer.Title className="font-figure m-0 mb-1 text-[23px] font-extrabold">
              {order ? money(Number(order.total), operator?.currency ?? "₹") : "Pay"}
            </Drawer.Title>
            <Drawer.Description className="m-0 mb-4 text-[13px] text-muted">
              {order?.token ? `Token ${order.token} · ` : ""}
              {operator?.short_name || operator?.name || "your operator"}
            </Drawer.Description>

            {order?.requote_status === "proposed" && (
              <Panel tone="clay">
                <AlertCircle size={15} strokeWidth={2.2} />
                The desk corrected this bill. Accept the new price on your order first, then pay.
              </Panel>
            )}
            {operator && gateway && !claimed && order && order.requote_status !== "proposed" && (
              <OnlinePay
                orderId={order.id}
                amount={Number(order.total)}
                currency={operator.currency ?? "₹"}
                onPaid={() => {
                  onClaimed();
                  onOpenChange(false);
                }}
                onCheckoutOpen={() => onOpenChange(false)}
              />
            )}

            {!operator ? (
              <Panel>
                <Loader2 size={15} className="animate-spin" />
                Loading…
              </Panel>
            ) : order?.requote_status === "proposed" ? null : !direct ? null : !request ? (
              <Panel tone="clay">
                <AlertCircle size={15} strokeWidth={2.2} />
                This operator hasn&apos;t added a UPI id yet — pay cash at the desk.
              </Panel>
            ) : (
              <>
                {/* The route that works in every app, for every kind of id:
                    the id and the amount a tap away, then the app's own
                    "pay to UPI id". A merchant id gets the one-tap link on
                    top — it fills the amount in the apps that accept links
                    from websites, and PhonePe is not one of them. */}
                {qrOnly ? (
                  <div className="mb-3 rounded-[16px] border border-line bg-surface p-3.5">
                    <p className="m-0 text-[13px] font-semibold">This desk is paid by scanning its QR</p>
                    <p className="m-0 mt-1 text-[12px] leading-relaxed text-muted">
                      A Paytm merchant id accepts nothing else — not a link, not the id typed in. Scan the
                      code below from another phone, or{" "}
                      <b className="font-semibold text-ink">screenshot it and open it from your UPI app&apos;s
                      scanner (&quot;Upload from gallery&quot;)</b>, then type{" "}
                      <b className="font-semibold text-ink tabular-nums">{money(Number(order?.total ?? 0), operator.currency)}</b>.
                    </p>
                    {!shopQr && (
                      <p className="m-0 mt-1.5 text-[12px] leading-relaxed text-clay-ink dark:text-clay">
                        The desk hasn&apos;t saved its standee&apos;s QR yet; the code below is Printifi&apos;s
                        copy and may be refused. Cash at the desk works.
                      </p>
                    )}
                  </div>
                ) : merchant ? (
                  <>
                    {onPhone && request ? (
                      <AppButtons request={request} platform={appPlatform} amount />
                    ) : (
                      <a
                        href={link ?? "#"}
                        className="flex h-[54px] w-full items-center justify-center gap-2.5 rounded-2xl bg-ink text-[15px] font-semibold text-paper"
                      >
                        <Smartphone size={17} strokeWidth={2.2} />
                        Open UPI app — amount filled in
                      </a>
                    )}
                    <p className="m-0 mt-2 mb-3 text-[11px] leading-relaxed text-muted">
                      The amount is filled in for you. <b className="font-semibold">PhonePe refuses payment
                      links from websites</b> (&quot;banking partner is unable to process&quot;) — there, use the
                      two steps below; it takes ten seconds.
                    </p>
                  </>
                ) : null}

                {qrOnly ? (
                  <button
                    onClick={() => copy("amount", amountText)}
                    className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl border border-line bg-surface px-3 py-2 text-ink"
                  >
                    <Copy size={13} strokeWidth={2.4} />
                    <span className="text-[12px] font-semibold text-muted">{copiedWhat === "amount" ? "Copied" : "Copy amount"}</span>
                    <span className="font-figure text-[17px] font-extrabold tabular-nums">
                      {money(Number(order?.total ?? 0), operator.currency)}
                    </span>
                  </button>
                ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => copy("id", operator.upi_vpa ?? "")}
                    className={cn(
                      "flex min-h-[54px] flex-col items-center justify-center gap-0.5 rounded-2xl px-3 py-2",
                      merchant ? "border border-line bg-surface text-ink" : "bg-ink text-paper",
                    )}
                  >
                    <span className={cn("flex items-center gap-1.5 text-[11px] font-semibold", merchant ? "text-muted" : "opacity-80")}>
                      <Copy size={12} strokeWidth={2.4} />
                      {copiedWhat === "id" ? "Copied" : "Copy UPI id"}
                    </span>
                    <span className="max-w-full truncate font-mono text-[12.5px]">{operator.upi_vpa}</span>
                  </button>
                  <button
                    onClick={() => copy("amount", amountText)}
                    className="flex min-h-[54px] flex-col items-center justify-center gap-0.5 rounded-2xl border border-line bg-surface px-3 py-2 text-ink"
                  >
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
                      <Copy size={12} strokeWidth={2.4} />
                      {copiedWhat === "amount" ? "Copied" : "Copy amount"}
                    </span>
                    <span className="font-figure text-[17px] font-extrabold tabular-nums">
                      {money(Number(order?.total ?? 0), operator.currency)}
                    </span>
                  </button>
                </div>
                )}
                {!qrOnly && (
                <ol className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0 text-[12.5px] leading-relaxed text-ink-soft">
                  <Step n={1}>
                    Open your UPI app and choose <b className="font-semibold">Pay to UPI id</b> (or
                    &quot;To contact / UPI id&quot;).
                  </Step>
                  <Step n={2}>
                    Paste the id, type{" "}
                    <b className="font-semibold tabular-nums">{money(Number(order?.total ?? 0), operator.currency)}</b>
                    {order?.token ? (
                      <>
                        , and put <b className="font-semibold">{order.token}</b> in the note.
                      </>
                    ) : (
                      "."
                    )}
                  </Step>
                </ol>
                )}
                {qr && (
                  <div className="mt-4 flex flex-col items-center gap-2">
                    <p className="m-0 text-[12px] text-muted">
                      {shopQr
                        ? "The desk's own QR — scan it and type the amount"
                        : qrOnly
                          ? "Scan this and type the amount"
                          : merchant
                            ? "On a laptop? Scan this — the amount is in it"
                            : "On a laptop? Scan this and type the amount"}
                    </p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qr}
                      alt={`UPI QR code for ${operator.upi_vpa}`}
                      className={cn("rounded-2xl border border-line bg-white p-2", qrOnly ? "size-[240px]" : "size-[180px]")}
                    />
                  </div>
                )}
                {!merchant && (
                  <>
                    {onPhone && request ? (
                      <div className="mt-3">
                        <p className="m-0 mb-1.5 text-[11.5px] text-muted">Or try opening an app — some accept it:</p>
                        <AppButtons request={request} platform={appPlatform} />
                      </div>
                    ) : (
                      <a
                        href={link ?? "#"}
                        className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface text-[12.5px] font-semibold text-ink-soft"
                      >
                        <Smartphone size={14} strokeWidth={2.2} />
                        Try opening your app anyway
                      </a>
                    )}
                    <p className="m-0 mt-2 text-[11px] leading-relaxed text-muted">
                      This desk uses a personal UPI id. UPI apps refuse a link with the amount already filled in
                      for those, so the amount is typed by hand.
                    </p>
                  </>
                )}
              </>
            )}

            {order?.requote_status !== "proposed" && operator && (
            <div className={cn("border-t border-line pt-4", gateway && !claimed ? "mt-1" : "mt-5")}>
              {claimed ? (
                <p className="m-0 flex items-center gap-2 rounded-[14px] bg-bone px-4 py-3 text-[12.5px] leading-relaxed text-ink">
                  <Check size={15} strokeWidth={2.6} className="shrink-0" />
                  {order?.payment_method === "cash"
                    ? `Cash it is — ${order?.delivery ? "the runner takes it at your door" : "the desk takes it when you collect"}.`
                    : "You've marked this as paid. The operator confirms it when they see the money."}
                </p>
              ) : gateway ? (
                // Printifi collects: the other way is cash, and only cash.
                cash ? (
                  <>
                    <p className="m-0 mb-3 text-[12.5px] leading-relaxed text-muted">
                      Or pay in cash{order?.delivery ? " at your door" : " at the counter"}.
                    </p>
                    <ClaimButton
                      busy={busy === "cash" || cash.disabled}
                      onClick={() => claim("cash")}
                      icon={<Banknote size={15} strokeWidth={2.2} />}
                      label={cash.label}
                    />
                    <p className={cn("m-0 mt-2 text-[11.5px] leading-relaxed", cash.ok ? "text-muted" : "text-clay-ink dark:text-clay")}>
                      {cash.hint}
                    </p>
                  </>
                ) : (
                  <p className="m-0 text-[11.5px] leading-relaxed text-muted">This desk takes online payment only.</p>
                )
              ) : (
                <>
                  <p className="m-0 mb-3 text-[12.5px] leading-relaxed text-muted">
                    Once you&apos;ve sent it, tell the operator so they can check and start printing.
                  </p>

                  {request && (
                    <label className="mb-3 flex flex-col gap-1.5">
                      <span className="text-[12px] font-semibold tracking-[-0.01em]">
                        Amount you sent{" "}
                        <span className="font-normal text-faint">as your app showed it</span>
                      </span>
                      <input
                        value={sent}
                        onChange={(e) => setSent(e.target.value.replace(/[^\d.]/g, ""))}
                        inputMode="decimal"
                        className={cn(
                          "rounded-xl border bg-surface px-3 py-2.5 font-mono text-[13px] outline-none focus:border-ink",
                          sentDiff !== 0 ? "border-clay" : "border-line",
                        )}
                      />
                      {sentDiff < 0 && (
                        <span className="text-[11.5px] leading-snug text-clay-ink dark:text-clay">
                          That&apos;s {money(-sentDiff, operator?.currency)} short of the bill — the desk will take
                          the rest in cash when you collect.
                        </span>
                      )}
                      {sentDiff > 0 && (
                        <span className="text-[11.5px] leading-snug text-clay-ink dark:text-clay">
                          That&apos;s {money(sentDiff, operator?.currency)} more than the bill — the desk will
                          return it.
                        </span>
                      )}
                    </label>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {request && (
                      <ClaimButton
                        busy={busy === "upi"}
                        onClick={() => claim("upi")}
                        icon={<Check size={15} strokeWidth={2.6} />}
                        label="I've paid by UPI"
                        primary
                      />
                    )}
                    {cash && (
                      <ClaimButton
                        busy={busy === "cash" || cash.disabled}
                        onClick={() => claim("cash")}
                        icon={<Banknote size={15} strokeWidth={2.2} />}
                        label={cash.label}
                      />
                    )}
                  </div>
                  {cash && (
                    <p className={cn("m-0 mt-2 text-[11.5px] leading-relaxed", cash.ok ? "text-muted" : "text-clay-ink dark:text-clay")}>
                      {cash.hint}
                    </p>
                  )}
                </>
              )}

              {error && (
                <p className="m-0 mt-2.5 text-[12px] text-clay-ink dark:text-clay">{error}</p>
              )}

              <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">
                {gateway
                  ? "Paid through Printifi, the order is confirmed the moment the money lands and the desk starts without checking anything. Cash is counted in the hand."
                  : "Printifi never holds your money — it goes straight to the operator. We can't see whether a transfer succeeded, so they confirm it themselves before printing."}
              </p>
            </div>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/**
 * One button per app the student is likely to have, each opening that app
 * and no other, plus "another app" for the phone's own chooser. `amount`
 * only changes the words: the link itself already carries the amount when
 * the desk's id can take it.
 */
function AppButtons({ request, platform, amount }: { request: UpiRequest; platform: "android" | "ios"; amount?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {UPI_APPS.map((app) => (
        <a
          key={app.id}
          href={appLink(app, request, platform)}
          className={cn(
            "flex h-[54px] flex-col items-center justify-center rounded-2xl text-[13px] font-semibold",
            amount ? "bg-ink text-paper" : "border border-line bg-surface text-ink",
          )}
        >
          {app.label}
          {app.refuses && <span className={cn("text-[9.5px] font-normal", amount ? "text-paper/70" : "text-muted")}>may refuse</span>}
        </a>
      ))}
      <a
        href={upiLink(request)}
        className="col-span-3 flex h-10 items-center justify-center gap-2 rounded-xl border border-line bg-surface text-[12.5px] font-semibold text-ink-soft"
      >
        <Smartphone size={14} strokeWidth={2.2} />
        Another UPI app
      </a>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-ink font-mono text-[10.5px] font-semibold text-paper">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function ClaimButton({
  busy,
  onClick,
  icon,
  label,
  primary,
}: {
  busy: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      transition={spring}
      disabled={busy}
      onClick={onClick}
      className={cn(
        // `sm:flex-1`, not `flex-1`: on a phone these stack in a column, and
        // there flex-1 makes the *height* basis zero, so h-12 loses and the
        // button collapses to the height of its label. Full width and 48px
        // tall when stacked; equal halves when side by side.
        "flex h-12 w-full shrink-0 items-center justify-center gap-2 rounded-xl text-[13.5px] font-semibold disabled:opacity-60 sm:w-auto sm:flex-1",
        primary ? "bg-ink text-paper" : "border border-line bg-surface text-ink-soft",
      )}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : icon}
      {label}
    </motion.button>
  );
}

function Panel({ children, tone }: { children: React.ReactNode; tone?: "clay" }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-[16px] border p-4 text-[13px]",
        tone === "clay" ? "border-clay bg-clay/25 text-ink" : "border-line bg-surface text-muted",
      )}
    >
      {children}
    </div>
  );
}
