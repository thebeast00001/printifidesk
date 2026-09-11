"use client";

import { useCallback, useEffect, useState } from "react";
import { useClerk, useUser } from "@clerk/nextjs";
import { motion } from "motion/react";
import { Bell, Check, Loader2, LogOut } from "lucide-react";
import { useAuthKey } from "@/hooks/use-auth-key";
import { ensureSession, getSupabase } from "@/lib/supabase/client";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/push";
import { useSurface } from "../surface-provider";
import { cn, spring } from "@/lib/utils";

interface Me {
  name: string | null;
  phone: string | null;
}

/**
 * The person behind the counter, on the desk's own site.
 *
 * Name and phone are the two things a desk needs about its staff — the name
 * is what "Handled by" and the staff tiles show, the phone is for the owner.
 * The student profile has a roll number and a hostel; none of that belongs
 * here. Push here means *new orders*, which is a different subscription from
 * a student's "your job is ready".
 */
export function AccountPanel() {
  const authKey = useAuthKey();
  const { user } = useUser();
  const clerk = useClerk();
  const { surface } = useSurface();
  const [me, setMe] = useState<Me | null>(null);
  const [draft, setDraft] = useState<{ name: string; phone: string }>({ name: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const session = await ensureSession();
    if (session.status !== "ready") return;
    const { data } = await getSupabase()!
      .from("profiles")
      .select("name, phone")
      .eq("id", session.userId)
      .maybeSingle();
    const row = (data as Me | null) ?? { name: null, phone: null };
    setMe(row);
    setDraft({ name: row.name ?? "", phone: row.phone ?? "" });
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Writes, then reads back and shows what the database holds — never what
   * was typed. A write RLS filters out affects zero rows without raising.
   */
  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const session = await ensureSession();
      if (session.status !== "ready") throw new Error("Sign in first.");
      const wanted = { name: draft.name.trim() || null, phone: draft.phone.trim() || null };
      const { error: writeError } = await getSupabase()!
        .from("profiles")
        .upsert({ id: session.userId, ...wanted }, { onConflict: "id" });
      if (writeError) throw new Error(writeError.message);
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  const dirty = me !== null && (draft.name.trim() !== (me.name ?? "") || draft.phone.trim() !== (me.phone ?? ""));

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <h2 className="font-heading m-0 text-[18px] font-bold">You</h2>
      <p className="m-0 mt-1 mb-4 text-[12.5px] text-muted">
        {user?.primaryEmailAddress?.emailAddress ?? "Signed in"}
        {" · "}what the desk sees on the staff list and on <i>Handled by</i>.
      </p>

      {me === null ? (
        <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={15} className="animate-spin" />
          Loading…
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
        >
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            maxLength={80}
            placeholder="Your name"
            aria-label="Name"
            className="h-11 min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[13px] outline-none focus:border-ink"
          />
          <input
            value={draft.phone}
            onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
            maxLength={32}
            inputMode="tel"
            placeholder="Phone"
            aria-label="Phone"
            className="h-11 min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[13px] outline-none focus:border-ink"
          />
          <button
            type="submit"
            disabled={busy || !dirty}
            className={cn(
              "flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[13px] font-semibold disabled:opacity-40",
              dirty ? "bg-ink text-paper" : "border border-line text-faint",
            )}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} strokeWidth={2.6} />}
            {saved ? "Saved" : "Save"}
          </button>
        </form>
      )}
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}

      <DeskPushRow />

      <button
        onClick={() => void clerk.signOut({ redirectUrl: surface === "desk" ? "/sign-in" : "/operator" })}
        className="mt-4 flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-surface-sunk"
      >
        <LogOut size={14} strokeWidth={2.2} />
        Sign out
      </button>
    </section>
  );
}

/**
 * New-order alerts on this device, with the tab closed. The subscription is
 * flagged as a desk one, so the dispatcher sends this device the desk's
 * pushes and the student's "ready" pushes go where they went before.
 */
function DeskPushRow() {
  const authKey = useAuthKey();
  const [state, setState] = useState<PushState>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void pushState().then(setState);
  }, [authKey]);

  const description: Record<PushState, string> = {
    checking: "Checking…",
    unsupported: "This browser can't do notifications. Try Chrome, Edge or Firefox.",
    unconfigured: "Not set up on the server — NEXT_PUBLIC_VAPID_PUBLIC_KEY is missing.",
    denied: "Blocked. Allow notifications for this site in your browser settings, then reload.",
    off: "A notification the moment a new order lands, even with this closed.",
    on: "On for this device. Every new order buzzes here.",
  };

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-line bg-surface-sunk p-4">
      <div className="min-w-0">
        <p className="m-0 text-[13px] font-semibold">New-order alerts</p>
        <p className="m-0 mt-0.5 text-[12px] leading-relaxed text-muted">{error ?? description[state]}</p>
      </div>
      {state === "checking" ? (
        <Loader2 size={14} className="animate-spin text-muted" />
      ) : state === "unsupported" || state === "unconfigured" || state === "denied" ? (
        <span className="rounded-full bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-muted">
          Unavailable
        </span>
      ) : (
        <motion.button
          whileTap={{ scale: 0.95 }}
          transition={spring}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setState(state === "on" ? await disablePush() : await enablePush({ desk: true }));
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't change that.");
            } finally {
              setBusy(false);
            }
          }}
          className={cn(
            "flex items-center gap-2 rounded-full px-4 py-2.5 text-[12.5px] font-semibold",
            state === "on" ? "border border-line bg-surface text-ink-soft" : "bg-ink text-paper",
          )}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Bell size={13} strokeWidth={2.2} />}
          {state === "on" ? "Turn off" : "Turn on"}
        </motion.button>
      )}
    </div>
  );
}
