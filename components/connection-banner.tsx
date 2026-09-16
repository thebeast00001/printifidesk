"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useAuthKey } from "@/hooks/use-auth-key";
import { ensureSession, getSupabase, whoami, type WhoAmI } from "@/lib/supabase/client";
import { cn, spring } from "@/lib/utils";

export type Verdict =
  | { kind: "checking" }
  | { kind: "ok" }
  | { kind: "signed-out" }
  | { kind: "blocked"; title: string; detail: string; steps: string[] };

/**
 * Says out loud why saving won't work, right where someone is trying to save.
 *
 * A rejected write is easy to miss — Postgres can filter an update to zero rows
 * without raising anything — so rather than wait for a save to fail, this
 * checks the two things that actually break (a token Supabase won't accept, and
 * a write that doesn't land) and names the fix.
 */
export function useConnectionVerdict(): {
  verdict: Verdict;
  recheck: () => Promise<void>;
} {
  const authKey = useAuthKey();
  const [verdict, setVerdict] = useState<Verdict>({ kind: "checking" });

  const check = useCallback(async () => {
    const session = await ensureSession();

    if (session.status === "loading") return setVerdict({ kind: "checking" });
    if (session.status === "signed-out") return setVerdict({ kind: "signed-out" });
    if (session.status !== "ready") {
      return setVerdict({
        kind: "blocked",
        title: "Printifi can't reach its database",
        detail: "message" in session ? session.message : "No connection.",
        steps: ["Check NEXT_PUBLIC_SUPABASE_URL and the publishable key in .env.local."],
      });
    }

    let identity: WhoAmI | null = null;
    try {
      identity = await whoami();
    } catch {
      /* handled below */
    }

    // Supabase rejected or ignored the Clerk token: it sees no subject, or the
    // anon role. Either way every policy will deny.
    if (!identity || !identity.clerk_sub || identity.jwt_role !== "authenticated") {
      return setVerdict({
        kind: "blocked",
        title: "Your details can't save yet",
        detail:
          identity && !identity.clerk_sub
            ? "Supabase isn't reading your Clerk sign-in, so it treats you as a stranger and blocks every write."
            : `Supabase sees your role as “${identity?.jwt_role ?? "unknown"}” instead of “authenticated”, so it blocks every write.`,
        steps: [
          "In Clerk → Configure → Integrations, turn on Supabase.",
          "In Supabase → Authentication → Third-Party Auth, add Clerk with the domain from your publishable key.",
          "Sign out and back in here so a fresh token is issued.",
        ],
      });
    }

    // The token is accepted — prove a write actually lands before promising it.
    const supabase = getSupabase();
    const { error } = await supabase!
      .from("profiles")
      .upsert({ id: session.userId }, { onConflict: "id" });

    if (error) {
      return setVerdict({
        kind: "blocked",
        title: "Your details can't save yet",
        detail: error.message,
        steps: ["Check that every migration in supabase/migrations has been run, in order."],
      });
    }

    setVerdict({ kind: "ok" });
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);

  useEffect(() => {
    void check();
  }, [check]);

  return { verdict, recheck: check };
}

export function ConnectionBanner() {
  const { verdict, recheck } = useConnectionVerdict();
  const [rechecking, setRechecking] = useState(false);

  if (verdict.kind !== "blocked") return null;

  return (
    <div className="rounded-[20px] border border-clay bg-clay/25 p-4 lg:p-5">
      <p className="m-0 flex items-center gap-2 text-[14.5px] font-semibold tracking-[-0.01em]">
        <AlertCircle size={17} strokeWidth={2.2} className="shrink-0" />
        {verdict.title}
      </p>
      <p className="m-0 mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{verdict.detail}</p>

      <ol className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
        {verdict.steps.map((step, i) => (
          <li key={step} className="flex gap-2.5 text-[12.5px] leading-relaxed">
            <span className="font-mono text-muted">{i + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>

      <motion.button
        whileTap={{ scale: 0.96 }}
        transition={spring}
        disabled={rechecking}
        onClick={async () => {
          setRechecking(true);
          await recheck();
          setRechecking(false);
        }}
        className={cn(
          "mt-3.5 flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-semibold text-paper",
          rechecking && "opacity-60",
        )}
      >
        {rechecking ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <RefreshCw size={14} strokeWidth={2.2} />
        )}
        Check again
      </motion.button>
    </div>
  );
}
