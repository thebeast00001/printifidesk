"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, KeyRound, Loader2, LogIn, Ticket } from "lucide-react";
import { claimInvite } from "@/lib/desk";
import { isAdmin } from "@/lib/operator";
import { OperatorApplication } from "./operator-application";
import { setMyPin } from "@/lib/desk-auth";
import { cn, easeIos } from "@/lib/utils";
import { useSurface } from "./surface-provider";

/**
 * Joining a desk with a code.
 *
 * Reached from a link (`/join/XK7P2Q4M`), a typed code (`/join`), or the
 * operator page when the signed-in person isn't on any desk yet. The join
 * itself is one tap — a code can be burned by the wrong person, so it is
 * never claimed just by loading the page. Afterwards, the PIN is offered
 * right away, because the next place they'll be is the counter device.
 */
export function JoinDesk({
  initialCode = "",
  onJoined,
  className,
}: {
  initialCode?: string;
  /** On the operator page: reload the board instead of navigating to it. */
  onJoined?: () => void;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { isLoaded, isSignedIn } = useAuth();
  const { desk } = useSurface();
  const [code, setCode] = useState(pretty(initialCode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<{ operatorId: string; operatorName: string } | null>(null);
  const [pin, setPin] = useState("");
  const [pinState, setPinState] = useState<"idle" | "saving" | "set">("idle");
  const [pinError, setPinError] = useState<string | null>(null);
  // The admin lands here too, on an account that's on no desk. They don't
  // need a code from anyone — they make them.
  const [admin, setAdmin] = useState(false);

  useEffect(() => setCode(pretty(initialCode)), [initialCode]);
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return setAdmin(false);
    void isAdmin().then(setAdmin);
  }, [isLoaded, isSignedIn]);

  const raw = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const complete = raw.length === 8;

  async function join() {
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      setJoined(await claimInvite(raw));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function savePin() {
    if (!joined || pin.length < 4) return;
    setPinState("saving");
    setPinError(null);
    try {
      await setMyPin(joined.operatorId, pin);
      setPinState("set");
      setPin("");
    } catch (e) {
      setPinState("idle");
      setPinError(e instanceof Error ? e.message : "Couldn't set that PIN.");
    }
  }

  function openDesk() {
    if (onJoined) onJoined();
    else router.push(desk("/operator"));
  }

  if (!isLoaded) {
    return (
      <Shell className={className}>
        <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={15} className="animate-spin" />
          One moment…
        </p>
      </Shell>
    );
  }

  if (!isSignedIn) {
    // Back here, with the code still in the URL, once Clerk is done.
    const here = pathname || "/join";
    return (
      <Shell className={className}>
        <Eyebrow />
        <h2 className="font-heading m-0 mt-1 text-[22px] font-bold">Sign in first</h2>
        <p className="m-0 mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-muted">
          {complete
            ? `You have a code${raw ? ` — ${pretty(raw)}` : ""}. Sign in once and it's yours; after that the counter device only ever asks for a PIN.`
            : "Sign in once, then type the code the desk gave you. After that the counter device only ever asks for a PIN."}
        </p>
        <Link
          href={`/sign-in?desk=1&redirect_url=${encodeURIComponent(here)}`}
          className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper"
        >
          <LogIn size={14} strokeWidth={2.2} />
          Sign in to join
        </Link>
      </Shell>
    );
  }

  return (
    <Shell className={className}>
      <AnimatePresence mode="wait" initial={false}>
        {!joined ? (
          <motion.div
            key="code"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: easeIos }}
          >
            <Eyebrow />
            <h2 className="font-heading m-0 mt-1 text-[22px] font-bold">Enter your code</h2>
            <p className="m-0 mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-muted">
              Type the code the desk gave you. It works once, and for a day.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void join();
              }}
              className="mt-4 flex flex-wrap gap-2"
            >
              <input
                value={code}
                onChange={(e) => {
                  setError(null);
                  setCode(pretty(e.target.value));
                }}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="XK7P-2Q4M"
                aria-label="Join code"
                className="h-12 min-w-[180px] flex-1 rounded-xl border border-line bg-surface-sunk px-3.5 font-mono text-[18px] tracking-[0.18em] uppercase outline-none placeholder:tracking-[0.18em] placeholder:text-faint focus:border-ink"
              />
              <button
                type="submit"
                disabled={!complete || busy}
                className={cn(
                  "flex h-12 items-center gap-2 rounded-xl px-4 text-[13px] font-semibold transition-colors disabled:opacity-40",
                  complete ? "bg-ink text-paper" : "border border-line text-faint",
                )}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} strokeWidth={2.4} />}
                Join
              </button>
            </form>
            {error && (
              <p className="m-0 mt-2.5 text-[12.5px] font-semibold text-clay-ink dark:text-clay">{error}</p>
            )}
            {admin ? (
              <p className="m-0 mt-3 rounded-xl border border-line bg-surface-sunk px-3 py-2.5 text-[12px] leading-relaxed">
                You&apos;re the admin. Desks and their owner codes are yours to make —{" "}
                <Link href="/admin/desks" className="font-semibold underline-offset-2 hover:underline">
                  open Desks
                </Link>
                , create one or pick an empty one, and <i>Run it myself</i> puts you on it in one tap.
              </p>
            ) : (
              <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">
                Joining someone&apos;s desk? They make your code under Settings → Staff. Starting your own?
                Apply below — an accepted application comes back as an owner code for this account.
              </p>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="joined"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: easeIos }}
          >
            <p className="m-0 flex items-center gap-1.5 text-[12px] font-semibold text-sage-ink">
              <Check size={14} strokeWidth={2.6} />
              You&apos;re on the desk
            </p>
            <h2 className="font-heading m-0 mt-1 text-[22px] font-bold">{joined.operatorName}</h2>

            <div className="mt-4 rounded-[16px] border border-line bg-surface-sunk p-4">
              <p className="m-0 flex items-center gap-1.5 text-[13px] font-semibold">
                <KeyRound size={14} strokeWidth={2.2} />
                Set a PIN for the counter device
              </p>
              <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">
                Four to six digits. On the desk&apos;s paired phone or tablet you&apos;ll tap your name and
                type this — no sign-in. You can do this later in Settings too.
              </p>
              {pinState === "set" ? (
                <p className="m-0 mt-2.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-sage-ink">
                  <Check size={14} strokeWidth={2.6} />
                  PIN set.
                </p>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void savePin();
                  }}
                  className="mt-2.5 flex gap-2"
                >
                  <input
                    value={pin}
                    onChange={(e) => {
                      setPinError(null);
                      setPin(e.target.value.replace(/\D/g, "").slice(0, 6));
                    }}
                    inputMode="numeric"
                    autoComplete="off"
                    type="password"
                    placeholder="4 to 6 digits"
                    aria-label="PIN"
                    className="h-11 w-40 rounded-xl border border-line bg-surface px-3 font-mono text-[15px] tracking-[0.3em] outline-none focus:border-ink"
                  />
                  <button
                    type="submit"
                    disabled={pinState === "saving" || pin.length < 4}
                    className={cn(
                      "flex h-11 items-center gap-2 rounded-xl px-4 text-[13px] font-semibold disabled:opacity-40",
                      pin.length >= 4 ? "bg-ink text-paper" : "border border-line text-faint",
                    )}
                  >
                    {pinState === "saving" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} strokeWidth={2.6} />}
                    Set PIN
                  </button>
                </form>
              )}
              {pinError && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{pinError}</p>}
            </div>

            <button
              onClick={openDesk}
              className="mt-4 flex h-11 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper"
            >
              Open the desk
              <ArrowRight size={14} strokeWidth={2.4} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {/* The other way onto a desk: your own, by application. Not for the
          admin, who makes desks rather than asks for them; not once joined. */}
      {!admin && !joined && (
        <div className="mt-4">
          <OperatorApplication />
        </div>
      )}
    </Shell>
  );
}

function Shell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-[20px] border border-line bg-surface p-5 shadow-card lg:p-6", className)}>
      {children}
    </div>
  );
}

function Eyebrow() {
  return (
    <p className="label-caps m-0 flex items-center gap-1.5">
      <Ticket size={12} strokeWidth={2.4} />
      Join code
    </p>
  );
}

/** Upper-case, strip what isn't a letter or digit, dash after four. */
function pretty(value: string): string {
  const raw = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}
