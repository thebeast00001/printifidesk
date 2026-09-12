"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, MonitorSmartphone, Trash2 } from "lucide-react";
import {
  forgetThisDevice,
  isPairedDevice,
  listDevices,
  pairThisDevice,
  revokeDevice,
  setMyPin,
  type DeskDevice,
} from "@/lib/desk-auth";
import type { Operator } from "@/lib/orders";
import { cn } from "@/lib/utils";

/**
 * Pairing and PINs.
 *
 * Pair the phone or tablet that lives at the counter once; after that a
 * shift starts with a name and a PIN instead of a password. The token
 * that makes a device "paired" is shown to nobody — it goes straight into
 * this browser's storage and only its hash is kept on the server.
 */
export function DevicePanel({
  operator,
  hasPin,
  onPinChanged,
}: {
  operator: Operator;
  hasPin: boolean;
  /** The desk shell keeps the PIN flag; tell it when one is set. */
  onPinChanged?: () => void;
}) {
  const [devices, setDevices] = useState<DeskDevice[] | null>(null);
  const [paired, setPaired] = useState(false);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    setDevices(await listDevices(operator.id));
    setPaired(isPairedDevice());
  }, [operator.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pair() {
    setBusy("pair");
    setNote(null);
    try {
      await pairThisDevice(operator.id, name || defaultName());
      setName("");
      setNote({ tone: "ok", text: "Paired. From now on this device opens to the staff list when nobody's signed in." });
      await load();
    } catch (e) {
      setNote({ tone: "bad", text: e instanceof Error ? e.message : "Couldn't pair." });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(d: DeskDevice) {
    setBusy(d.id);
    setNote(null);
    try {
      await revokeDevice(d.id);
      await load();
    } catch (e) {
      setNote({ tone: "bad", text: e instanceof Error ? e.message : "Couldn't revoke." });
    } finally {
      setBusy(null);
    }
  }

  async function savePin() {
    setBusy("pin");
    setNote(null);
    try {
      await setMyPin(operator.id, pin);
      setPin("");
      setNote({ tone: "ok", text: "PIN set. It works on any device paired to this desk." });
      onPinChanged?.();
    } catch (e) {
      setNote({ tone: "bad", text: e instanceof Error ? e.message : "Couldn't set that PIN." });
    } finally {
      setBusy(null);
    }
  }

  const live = (devices ?? []).filter((d) => !d.revoked_at);

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <h2 className="font-heading m-0 text-[18px] font-bold">Desk sign-in</h2>
      <p className="m-0 mt-1 mb-4 max-w-[60ch] text-[12.5px] leading-relaxed text-muted">
        Pair the phone or tablet at the counter once. After that, whoever&apos;s on shift taps their
        name and types a PIN — no password, no email. Nothing else about who can do what changes.
      </p>

      {/* ---- your PIN ---- */}
      <div className="rounded-[16px] border border-line bg-surface-sunk p-4">
        <p className="label-caps m-0">Your PIN</p>
        <p className="m-0 mt-1 text-[12.5px] text-muted">
          {hasPin
            ? "Set. Forgotten it? Enter a new one — it replaces the old one on every paired device and clears any lockout."
            : "Not set yet — you can't use desk sign-in until it is."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void savePin();
          }}
          className="mt-2.5 flex gap-2"
        >
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="off"
            type="password"
            placeholder="4 to 6 digits"
            className="w-40 rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-[15px] tracking-[0.3em] outline-none focus:border-ink"
          />
          <button
            type="submit"
            disabled={busy === "pin" || pin.length < 4}
            className={cn(
              "flex h-11 items-center gap-2 rounded-xl px-4 text-[13px] font-semibold disabled:opacity-40",
              pin.length >= 4 ? "bg-ink text-paper" : "border border-line text-faint",
            )}
          >
            {busy === "pin" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} strokeWidth={2.6} />}
            {hasPin ? "Change" : "Set PIN"}
          </button>
        </form>
      </div>

      {/* ---- this device ---- */}
      <div className="mt-3 rounded-[16px] border border-line bg-surface-sunk p-4">
        <p className="label-caps m-0">This device</p>
        {paired ? (
          <>
            <p className="m-0 mt-1 flex items-center gap-1.5 text-[12.5px] text-sage-ink">
              <Check size={14} strokeWidth={2.6} />
              Paired to this desk.
            </p>
            <button
              onClick={() => {
                forgetThisDevice();
                setPaired(false);
                setNote({ tone: "ok", text: "This browser forgot its pairing. Revoke it below to be sure." });
              }}
              className="mt-2.5 text-[12px] font-semibold text-muted underline-offset-2 hover:underline"
            >
              Forget pairing on this browser
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void pair();
            }}
            className="mt-2.5 flex flex-wrap gap-2"
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder={defaultName()}
              className="min-w-[160px] flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] outline-none focus:border-ink"
            />
            <button
              type="submit"
              disabled={busy === "pair"}
              className="flex h-11 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-60"
            >
              {busy === "pair" ? <Loader2 size={14} className="animate-spin" /> : <MonitorSmartphone size={14} strokeWidth={2.2} />}
              Pair this device
            </button>
          </form>
        )}
      </div>

      {/* ---- all devices ---- */}
      {devices !== null && live.length > 0 && (
        <div className="mt-3">
          <p className="label-caps m-0 mb-1.5">Paired devices</p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {live.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 rounded-xl border border-line bg-surface-sunk px-3 py-2.5 text-[12.5px]"
              >
                <MonitorSmartphone size={14} strokeWidth={2.2} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{d.name}</span>
                  <span className="block font-mono text-[10.5px] text-muted">
                    paired {new Date(d.created_at).toLocaleDateString([], { day: "numeric", month: "short" })}
                    {d.last_seen_at
                      ? ` · last used ${new Date(d.last_seen_at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`
                      : " · not used yet"}
                  </span>
                </span>
                <button
                  onClick={() => revoke(d)}
                  disabled={busy === d.id}
                  aria-label={`Revoke ${d.name}`}
                  title="Revoke — that device stops working for desk sign-in immediately"
                  className="grid size-9 shrink-0 place-items-center rounded-lg border border-line text-muted transition-colors hover:text-clay-ink disabled:opacity-40"
                >
                  {busy === d.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={14} strokeWidth={2.2} />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {note && (
        <p
          className={cn(
            "m-0 mt-3 text-[12px] leading-relaxed",
            note.tone === "ok" ? "text-sage-ink" : "text-clay-ink dark:text-clay",
          )}
        >
          {note.text}
        </p>
      )}

      <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">
        Lost a device? Revoke it here and it&apos;s done. In the Clerk dashboard, set the session
        lifetime to 30 days so a paired desk stays signed in between shifts.
      </p>
    </section>
  );
}

function defaultName(): string {
  if (typeof navigator === "undefined") return "Counter device";
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return "Counter iPad";
  if (/iPhone/.test(ua)) return "Counter iPhone";
  if (/Android/.test(ua)) return "Counter Android";
  return "Counter laptop";
}
