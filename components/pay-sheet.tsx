"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import QRCode from "qrcode";
import { AlertCircle, Banknote, Check, Copy, Loader2, Smartphone } from "lucide-react";
import { getOperator, type Operator, type OrderRow } from "@/lib/orders";
import { getSupabase } from "@/lib/supabase/client";
import { isValidVpa, upiLink, type UpiRequest } from "@/lib/upi";
import { money } from "@/lib/pricing";
import { cn, spring } from "@/lib/utils";

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
  const [operator, setOperator] = useState<Operator | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"upi" | "cash" | null>(null);
  const [reference, setReference] = useState("");
  // What their app's success screen showed. Pre-filled with the bill; a
  // different number is a warning now instead of a surprise at the counter.
  const [sent, setSent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !order) return;
    setError(null);
    setSent(Number(order.total).toFixed(2));
    void getOperator(order.operator_id).then(setOperator);
  }, [open, order]);

  const merchant = operator?.upi_kind === "merchant";
  const request = useMemo<UpiRequest | null>(() => {
    if (!order || !operator?.upi_vpa || !isValidVpa(operator.upi_vpa)) return null;
    return {
      vpa: operator.upi_vpa,
      payeeName: operator.upi_name?.trim() || operator.short_name || operator.name,
      // A personal id can't take the amount in the link; the payer types it.
      amount: operator.upi_kind === "merchant" ? Number(order.total) : undefined,
      merchantCode: operator.upi_kind === "merchant" ? operator.upi_mc : null,
      note: `Printify ${order.token ?? ""}`.trim(),
      reference: order.token ?? order.id.slice(0, 12),
    };
  }, [order, operator]);

  const link = request ? upiLink(request) : null;
  const amountText = order ? Number(order.total).toFixed(2) : "";
  const [copiedWhat, setCopiedWhat] = useState<"id" | "amount" | null>(null);
  async function copy(what: "id" | "amount", text: string) {
    await navigator.clipboard?.writeText(text);
    setCopiedWhat(what);
    setTimeout(() => setCopiedWhat(null), 1600);
  }

  useEffect(() => {
    if (!link) return setQr(null);
    // Rendered locally — the payment link never leaves the device.
    void QRCode.toDataURL(link, { margin: 1, width: 480, errorCorrectionLevel: "M" })
      .then(setQr)
      .catch(() => setQr(null));
  }, [link]);

  const claim = useCallback(
    async (method: "upi" | "cash") => {
      if (!order) return;
      setBusy(method);
      setError(null);
      const supabase = getSupabase();
      const { error: writeError } = await supabase!
        .from("orders")
        .update({
          payment_method: method,
          payment_claimed_at: new Date().toISOString(),
          // The UPI reference turns the operator's check from a guess into a
          // lookup in their own statement.
          payment_reference: method === "upi" ? reference.trim() || null : null,
          payment_claimed_amount:
            method === "upi" && sent.trim() !== "" && Number.isFinite(Number(sent)) ? Number(sent) : null,
        })
        .eq("id", order.id);
      setBusy(null);

      if (writeError) {
        setError(writeError.message);
        return;
      }
      onClaimed();
      onOpenChange(false);
    },
    [order, reference, sent, onClaimed, onOpenChange],
  );

  const sentValue = Number(sent);
  const sentDiff =
    order && sent.trim() !== "" && Number.isFinite(sentValue)
      ? Math.round((sentValue - Number(order.total)) * 100) / 100
      : 0;

  const claimed = Boolean(order?.payment_claimed_at);

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

            {!operator ? (
              <Panel>
                <Loader2 size={15} className="animate-spin" />
                Loading…
              </Panel>
            ) : !request ? (
              <Panel tone="clay">
                <AlertCircle size={15} strokeWidth={2.2} />
                This operator hasn&apos;t added a UPI id yet — pay cash at the desk.
              </Panel>
            ) : merchant ? (
              <>
                {/* Phones open the app; laptops scan the code. Both are shown
                    rather than guessed at, since a wrong guess is a dead end. */}
                <a
                  href={link ?? "#"}
                  className="flex h-[54px] w-full items-center justify-center gap-2.5 rounded-2xl bg-ink text-[15px] font-semibold text-paper"
                >
                  <Smartphone size={17} strokeWidth={2.2} />
                  Open UPI app
                </a>
                {qr && (
                  <div className="mt-4 flex flex-col items-center gap-2.5">
                    <p className="m-0 text-[12px] text-muted">or scan from your phone</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qr}
                      alt={`UPI QR code for ${money(Number(order?.total ?? 0), operator.currency)}`}
                      className="size-[220px] rounded-2xl border border-line bg-white p-2"
                    />
                  </div>
                )}

                <button
                  onClick={() => copy("id", operator.upi_vpa ?? "")}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 py-2.5 font-mono text-[12.5px] text-ink-soft"
                >
                  <Copy size={13} strokeWidth={2.2} />
                  {copiedWhat === "id" ? "Copied" : operator.upi_vpa}
                </button>
              </>
            ) : (
              <>
                {/* A personal id: the apps refuse a link with the amount in it,
                    so this is the route that works in every one of them. */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => copy("id", operator.upi_vpa ?? "")}
                    className="flex min-h-[54px] flex-col items-center justify-center gap-0.5 rounded-2xl bg-ink px-3 py-2 text-paper"
                  >
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold opacity-80">
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
                {qr && (
                  <div className="mt-4 flex flex-col items-center gap-2">
                    <p className="m-0 text-[12px] text-muted">On a laptop? Scan this and type the amount</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qr}
                      alt={`UPI QR code for ${operator.upi_vpa}`}
                      className="size-[180px] rounded-2xl border border-line bg-white p-2"
                    />
                  </div>
                )}
                <a
                  href={link ?? "#"}
                  className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface text-[12.5px] font-semibold text-ink-soft"
                >
                  <Smartphone size={14} strokeWidth={2.2} />
                  Try opening your app anyway
                </a>
                <p className="m-0 mt-2 text-[11px] leading-relaxed text-muted">
                  This desk uses a personal UPI id. UPI apps refuse a link with the amount already filled in
                  for those, so the amount is typed by hand.
                </p>
              </>
            )}

            <div className="mt-5 border-t border-line pt-4">
              {claimed ? (
                <p className="m-0 flex items-center gap-2 rounded-[14px] bg-bone px-4 py-3 text-[12.5px] leading-relaxed text-ink">
                  <Check size={15} strokeWidth={2.6} className="shrink-0" />
                  You&apos;ve marked this as paid. The operator confirms it when they see the money.
                </p>
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
                  {request && (
                    <label className="mb-3 flex flex-col gap-1.5">
                      <span className="text-[12px] font-semibold tracking-[-0.01em]">
                        UPI reference{" "}
                        <span className="font-normal text-faint">optional, speeds up the check</span>
                      </span>
                      <input
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                        inputMode="numeric"
                        maxLength={24}
                        placeholder="The 12-digit number in your UPI app"
                        className="rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-[13px] outline-none focus:border-ink"
                      />
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
                    {operator?.accepts_cash !== false && (
                      <ClaimButton
                        busy={busy === "cash"}
                        onClick={() => claim("cash")}
                        icon={<Banknote size={15} strokeWidth={2.2} />}
                        label="I'll pay cash at the desk"
                      />
                    )}
                  </div>
                </>
              )}

              {error && (
                <p className="m-0 mt-2.5 text-[12px] text-clay-ink dark:text-clay">{error}</p>
              )}

              <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">
                Printify never holds your money — it goes straight to the operator. We can&apos;t see
                whether a transfer succeeded, so they confirm it themselves before printing.
              </p>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
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
