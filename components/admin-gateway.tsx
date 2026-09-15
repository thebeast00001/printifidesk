"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CreditCard, Loader2, RefreshCw } from "lucide-react";
import { checkDesk, connectDesk, disconnectDesk, gatewayMode } from "@/lib/gateway";
import { setGatewayCollect } from "@/lib/platform";
import type { Desk } from "@/lib/operator";
import { cn, easeIos } from "@/lib/utils";

/**
 * Connecting a desk to Cashfree Easy Split — the admin's lever, because it
 * commits Printify's Cashfree account. The desk's settlement account goes
 * in (bank or UPI), Cashfree verifies it, and the desk shows "pay online"
 * only once Cashfree says ACTIVE. Nothing about a desk's direct UPI id
 * changes; online payment sits beside it.
 */
export function GatewayPanel({ desk, onChanged }: { desk: Desk; onChanged: () => Promise<void> | void }) {
  const mode = gatewayMode();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"connect" | "check" | "disconnect" | "collect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [accountType, setAccountType] = useState<"INDIVIDUAL" | "BUSINESS">("INDIVIDUAL");
  const [pan, setPan] = useState("");
  const [how, setHow] = useState<"bank" | "upi">("bank");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [vpa, setVpa] = useState("");

  const status = desk.gateway_status ?? "off";

  async function connect() {
    setBusy("connect");
    setError(null);
    setNote(null);
    try {
      const result = await connectDesk({
        operatorId: desk.id,
        name,
        email,
        phone,
        accountType,
        pan: pan || undefined,
        bank: how === "bank" ? { accountNumber, ifsc, accountHolder: name } : undefined,
        upi: how === "upi" ? { vpa, accountHolder: name } : undefined,
      });
      setNote(
        result.status === "active"
          ? "Connected. Cashfree verified the account; students at this desk can pay online now."
          : `Sent to Cashfree (${result.cashfreeStatus || "pending"}). It verifies the account, usually within minutes; check back with the button.`,
      );
      setOpen(false);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect the desk.");
    } finally {
      setBusy(null);
    }
  }

  async function collect(on: boolean) {
    setBusy("collect");
    setError(null);
    setNote(null);
    try {
      await setGatewayCollect(desk.id, on);
      setNote(on ? "On. Students at this desk can pay through Cashfree; the money settles to Printify and this desk's share shows under Payouts on the Fees page." : "Off. Students pay the desk directly again.");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change that.");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm(`Forget ${desk.name}'s Cashfree connection here? Students stop seeing online payment at this desk until it's connected again.`)) return;
    setBusy("disconnect");
    setError(null);
    setNote(null);
    try {
      await disconnectDesk(desk.id);
      setNote("Disconnected here. Connect again with the account for this environment.");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't disconnect.");
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    setBusy("check");
    setError(null);
    setNote(null);
    try {
      const result = await checkDesk(desk.id);
      setNote(`Cashfree says ${result.cashfreeStatus ?? result.status}.`);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 flex items-center gap-1.5 text-[12.5px] font-semibold">
          <CreditCard size={13} strokeWidth={2.2} />
          Online payments
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
              status === "active"
                ? "bg-sage text-sage-ink"
                : status === "pending"
                  ? "bg-bone text-ink"
                  : status === "blocked"
                    ? "bg-clay text-clay-ink"
                    : "bg-surface-sunk text-muted",
            )}
          >
            {status === "active" ? "split" : status === "collect" ? "on" : status === "pending" ? "verifying" : status === "blocked" ? "refused" : "off"}
          </span>
        </p>
        {!mode ? (
          <p className="m-0 text-[11.5px] text-muted">Cashfree isn&apos;t configured on this deployment.</p>
        ) : !desk.gateway_vendor_id ? (
          <span className="flex items-center gap-3">
            <button
              onClick={() => void collect(status !== "collect")}
              disabled={busy !== null}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11.5px] font-semibold disabled:opacity-50",
                status === "collect" ? "border border-line text-ink-soft" : "bg-ink text-paper",
              )}
            >
              {busy === "collect" ? <Loader2 size={12} className="animate-spin" /> : null}
              {status === "collect" ? "Turn off" : "Turn on — Printify collects"}
            </button>
            <button
              onClick={() => setOpen((v) => !v)}
              className="text-[11.5px] font-semibold text-muted underline-offset-2 hover:underline"
            >
              {open ? "Not now" : "Split at source instead"}
            </button>
          </span>
        ) : desk.gateway_vendor_id ? (
          <span className="flex items-center gap-3">
            <button
              onClick={() => void check()}
              disabled={busy !== null}
              className="flex items-center gap-1.5 text-[11.5px] font-semibold text-muted underline-offset-2 hover:underline disabled:opacity-50"
            >
              {busy === "check" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} strokeWidth={2.2} />}
              Check with Cashfree
            </button>
            <button
              onClick={() => void disconnect()}
              disabled={busy !== null}
              className="text-[11.5px] font-semibold text-muted underline-offset-2 hover:text-clay-ink hover:underline disabled:opacity-50"
            >
              {busy === "disconnect" ? "…" : "Disconnect"}
            </button>
          </span>
        ) : (
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[11.5px] font-semibold text-ink underline-offset-2 hover:underline"
          >
            {open ? "Not now" : "Connect this desk"}
          </button>
        )}
      </div>
      {status === "active" && (
        <p className="m-0 mt-1 text-[11.5px] text-muted">
          Students pay through Cashfree; the fee is taken at source and the desk&apos;s share settles to its account daily.
        </p>
      )}
      {status === "collect" && (
        <p className="m-0 mt-1 text-[11.5px] text-muted">
          Students pay through Cashfree; the money settles to Printify. The desk&apos;s share — bill less fee — is owed to
          it and paid out by you; see <b className="font-semibold">Payouts</b> on the Fees page.
        </p>
      )}
      {status === "off" && mode && !desk.gateway_vendor_id && (
        <p className="m-0 mt-1 text-[11.5px] text-muted">
          Off: students pay the desk directly. Turn on to offer Cashfree&apos;s checkout with Printify collecting; &quot;split
          at source&quot; needs Easy Split on the Cashfree account.
        </p>
      )}
      {note && <p className="m-0 mt-1.5 text-[12px] text-sage-ink">{note}</p>}
      {error && <p className="m-0 mt-1.5 text-[12px] text-clay-ink dark:text-clay">{error}</p>}

      <AnimatePresence initial={false}>
        {open && mode && !desk.gateway_vendor_id && (
          <motion.form
            key="connect"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: easeIos }}
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
            className="overflow-hidden"
          >
            <div className="mt-2.5 rounded-[14px] bg-surface-sunk p-3.5">
              <p className="m-0 mb-2.5 text-[12px] leading-relaxed text-muted">
                Split at source needs <b className="font-semibold">Easy Split</b> enabled on the Cashfree account; without it
                this returns Cashfree&apos;s refusal. The account the desk&apos;s share settles to — Cashfree verifies it before
                anything is paid; the holder&apos;s name must match the bank&apos;s record.{" "}
                {mode === "sandbox" ? "Sandbox mode — Cashfree's test account, no real money." : ""}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Account holder's name" value={name} onChange={setName} placeholder="As the bank has it" />
                <Field label="Email" value={email} onChange={setEmail} placeholder="Settlement notices go here" type="email" />
                <Field label="Phone" value={phone} onChange={(v) => setPhone(v.replace(/\D/g, "").slice(0, 12))} placeholder="10 digits" inputMode="numeric" />
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] font-semibold">Account type</span>
                  <select
                    value={accountType}
                    onChange={(e) => setAccountType(e.target.value as "INDIVIDUAL" | "BUSINESS")}
                    className="h-10 rounded-lg border border-line bg-surface px-2.5 text-[13px] outline-none focus:border-ink"
                  >
                    <option value="INDIVIDUAL">Individual (the owner&apos;s own account)</option>
                    <option value="BUSINESS">Business (a current account)</option>
                  </select>
                </label>
                <Field label="PAN (optional, helps verification)" value={pan} onChange={(v) => setPan(v.toUpperCase().slice(0, 10))} placeholder="ABCDE1234F" />
              </div>

              <div className="mt-3 flex gap-0.5 rounded-full border border-line bg-surface p-1 sm:w-fit">
                {(["bank", "upi"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setHow(k)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors",
                      how === k ? "bg-ink text-paper" : "text-muted hover:text-ink-soft",
                    )}
                  >
                    {k === "bank" ? "Bank account" : "UPI id"}
                  </button>
                ))}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {how === "bank" ? (
                  <>
                    <Field label="Account number" value={accountNumber} onChange={(v) => setAccountNumber(v.replace(/\D/g, ""))} placeholder="" inputMode="numeric" />
                    <Field label="IFSC" value={ifsc} onChange={(v) => setIfsc(v.toUpperCase().slice(0, 11))} placeholder="HDFC0001234" />
                  </>
                ) : (
                  <Field label="UPI id" value={vpa} onChange={setVpa} placeholder="name@bank — settlements land here" />
                )}
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  type="submit"
                  disabled={busy !== null || !name || !email || !phone || (how === "bank" ? !accountNumber || !ifsc : !vpa)}
                  className="flex h-10 items-center gap-1.5 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper disabled:opacity-40"
                >
                  {busy === "connect" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.6} />}
                  Connect through Cashfree
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="h-10 rounded-xl border border-line px-3.5 text-[12.5px] font-semibold text-ink-soft"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
  inputMode?: "numeric" | "text";
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-semibold">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        inputMode={inputMode}
        spellCheck={false}
        className="h-10 rounded-lg border border-line bg-surface px-2.5 text-[13px] outline-none focus:border-ink"
      />
    </label>
  );
}
