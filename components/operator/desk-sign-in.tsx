"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Delete, Loader2, LockKeyhole } from "lucide-react";
import { deskStaff, deskTicket, deviceToken, forgetThisDevice, type DeskStaff } from "@/lib/desk-auth";
import { cn, easeIos, spring } from "@/lib/utils";
import { useSurface } from "../surface-provider";

/**
 * A shift starts here: tap your name, type your PIN.
 *
 * Shown only on a paired device with nobody signed in. Big tiles, a big
 * keypad, and nothing else — a counter at nine in the morning, not a login
 * form. The PIN goes to the server, the server comes back with a Clerk
 * ticket, and the ticket becomes a normal session; from that moment the app
 * is exactly what it is after an email-and-password sign-in.
 */
export function DeskSignIn() {
  const router = useRouter();
  // The resource API rather than the useSignIn hook: Clerk 7's hook is a
  // signal-shaped wrapper whose create() reports only an error, and the
  // ticket flow needs the resulting session id to activate it.
  const clerk = useClerk();
  const { desk, surface } = useSurface();
  // The desk's own door, and back to the desk afterwards.
  const door = `/sign-in?${surface === "desk" ? "" : "desk=1&"}redirect_url=${encodeURIComponent(desk("/operator"))}`;

  const [staff, setStaff] = useState<DeskStaff[] | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const [who, setWho] = useState<DeskStaff | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = deviceToken();

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const rows = await deskStaff(token);
      if (rows.length === 0) {
        // A token that lists nobody has been revoked — or the desk has no
        // staff, which can't happen for a device that was paired by one.
        setBroken("This device is no longer paired to a desk.");
        return;
      }
      setStaff(rows);
    } catch (e) {
      setBroken(e instanceof Error ? e.message : "Couldn't reach the desk.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (candidate: string) => {
      if (!who || !token || !clerk.loaded || !clerk.client) return;
      setBusy(true);
      setError(null);
      try {
        const ticket = await deskTicket(token, who.user_id, candidate);
        const result = await clerk.client.signIn.create({ strategy: "ticket", ticket });
        if (result.status !== "complete" || !result.createdSessionId) {
          throw new Error("Clerk didn't complete the sign-in.");
        }
        await clerk.setActive({ session: result.createdSessionId });
        router.replace(desk("/operator"));
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't sign in.");
        setPin("");
      } finally {
        setBusy(false);
      }
    },
    [who, token, clerk, router, desk],
  );

  // A six-digit PIN submits itself; four or five digits take the lock key,
  // since the pad can't know where a shorter PIN ends.
  const press = (d: string) => {
    if (busy) return;
    setError(null);
    setPin((p) => (p + d).slice(0, 6));
  };

  useEffect(() => {
    if (pin.length === 6) void submit(pin);
  }, [pin, submit]);

  if (!token) return null;

  if (broken) {
    return (
      <div className="rounded-[20px] border border-line bg-surface p-5 text-center shadow-card">
        <p className="m-0 text-[14px] font-semibold">{broken}</p>
        <p className="m-0 mt-1.5 text-[12.5px] text-muted">
          Sign in with your email and password and pair it again from Settings, or use another device.
        </p>
        <button
          onClick={() => {
            forgetThisDevice();
            router.refresh();
          }}
          className="mt-4 rounded-xl border border-line px-4 py-2.5 text-[13px] font-semibold text-ink-soft"
        >
          Forget this pairing
        </button>
      </div>
    );
  }

  if (!staff) {
    return (
      <div className="flex items-center gap-2.5 rounded-[20px] border border-line bg-surface p-5 text-[13px] text-muted">
        <Loader2 size={15} className="animate-spin" />
        Finding the desk…
      </div>
    );
  }

  return (
    <div className="rounded-[24px] border border-line bg-surface p-5 shadow-card lg:p-6">
      <AnimatePresence mode="wait" initial={false}>
        {!who ? (
          <motion.div
            key="who"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.22, ease: easeIos }}
          >
            <p className="label-caps m-0">{staff[0].operator_name}</p>
            <h2 className="font-heading m-0 mt-1 text-[24px] font-bold">Who&apos;s on?</h2>
            <p className="m-0 mt-1 mb-4 text-[12.5px] text-muted">Tap your name to start your shift.</p>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {staff.map((s) => (
                <motion.button
                  key={s.user_id}
                  whileTap={{ scale: 0.97 }}
                  transition={spring}
                  onClick={() => {
                    setWho(s);
                    setPin("");
                    setError(null);
                  }}
                  className="flex min-h-[88px] flex-col items-start justify-between rounded-[18px] border border-line bg-surface-sunk p-3.5 text-left transition-colors hover:border-ink"
                >
                  <span className="grid size-9 place-items-center rounded-full bg-ink text-[13px] font-bold text-paper">
                    {initials(s.name)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold">{s.name}</span>
                    {!s.has_pin && (
                      <span className="block text-[10.5px] text-muted">no PIN yet</span>
                    )}
                  </span>
                </motion.button>
              ))}
            </div>

            <p className="m-0 mt-4 text-[11px] leading-relaxed text-muted">
              Not on the list? Ask whoever runs the desk for a join code. No PIN yet, or forgotten
              it?{" "}
              <Link href={door} className="font-semibold text-ink-soft underline-offset-2 hover:underline">
                Sign in with your email and password
              </Link>{" "}
              and set one under Settings → Desk sign-in. A new PIN replaces the old one everywhere.
            </p>
          </motion.div>
        ) : (
          <motion.div
            key="pin"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ duration: 0.22, ease: easeIos }}
          >
            <button
              onClick={() => {
                setWho(null);
                setPin("");
                setError(null);
              }}
              className="mb-3 flex items-center gap-1.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
            >
              <ArrowLeft size={14} strokeWidth={2.2} />
              Not {who.name.split(" ")[0]}
            </button>

            <h2 className="font-heading m-0 text-[24px] font-bold">Hi, {who.name.split(" ")[0]}</h2>
            <p className="m-0 mt-1 text-[12.5px] text-muted">
              {who.has_pin ? (
                <>
                  Your PIN, then you&apos;re in. Forgotten it?{" "}
                  <Link href={door} className="font-semibold text-ink-soft underline-offset-2 hover:underline">
                    Sign in with your email
                  </Link>{" "}
                  and set a new one.
                </>
              ) : (
                <>
                  You haven&apos;t set a PIN yet —{" "}
                  <Link href={door} className="font-semibold text-ink-soft underline-offset-2 hover:underline">
                    sign in with your email
                  </Link>{" "}
                  once and set one under Settings → Desk sign-in.
                </>
              )}
            </p>

            {/* Dots, not digits: a PIN typed at a counter is typed in front of people. */}
            <div className="my-5 flex items-center justify-center gap-3" aria-label={`${pin.length} digits entered`}>
              {Array.from({ length: 6 }).map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "size-3 rounded-full border transition-colors",
                    i < pin.length ? "border-ink bg-ink" : i < 4 ? "border-line-strong" : "border-line",
                  )}
                />
              ))}
            </div>

            <div className="mx-auto grid max-w-[280px] grid-cols-3 gap-2">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <Key key={d} onClick={() => press(d)} disabled={busy || !who.has_pin}>
                  {d}
                </Key>
              ))}
              <Key
                onClick={() => setPin((p) => p.slice(0, -1))}
                disabled={busy || pin.length === 0}
                muted
                label="Delete"
              >
                <Delete size={18} strokeWidth={2} />
              </Key>
              <Key onClick={() => press("0")} disabled={busy || !who.has_pin}>
                0
              </Key>
              <Key
                onClick={() => void submit(pin)}
                disabled={busy || pin.length < 4}
                primary
                label="Sign in"
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : <LockKeyhole size={18} strokeWidth={2.2} />}
              </Key>
            </div>

            {error && (
              <p className="m-0 mt-4 text-center text-[12.5px] font-semibold text-clay-ink dark:text-clay">{error}</p>
            )}
            <p className="m-0 mt-3 text-center text-[11px] text-muted">
              Four to six digits. Five wrong tries locks it for five minutes.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Key({
  children,
  onClick,
  disabled,
  primary,
  muted,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  muted?: boolean;
  label?: string;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      transition={spring}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "grid h-[58px] place-items-center rounded-[16px] text-[22px] font-semibold tabular-nums transition-colors disabled:opacity-40",
        primary
          ? "bg-ink text-paper"
          : muted
            ? "text-muted hover:bg-surface-sunk"
            : "border border-line bg-surface-sunk text-ink hover:border-ink",
      )}
    >
      {children}
    </motion.button>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";
}
