"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { AlertCircle, CircleCheck, CircleSlash, Copy, Loader2 } from "lucide-react";
import { SettingsGroup, SettingsRow } from "./settings-ui";
import { useAuthKey } from "@/hooks/use-auth-key";
import {
  ensureSession,
  isSupabaseConfigured,
  whoami,
  type SessionState,
  type WhoAmI,
} from "@/lib/supabase/client";
import { useProfileSync } from "@/lib/profile-sync";
import { staffOperatorId } from "@/lib/orders";
import { adminsExist, claimFirstAdmin, isAdmin } from "@/lib/operator";
import { cn } from "@/lib/utils";

/**
 * Setup diagnostics — for whoever runs this, not for students.
 *
 * A student never configures a database, so none of this belongs on /profile.
 * It lives on its own unlinked route instead. Everything here is scoped to the
 * caller's own session, so it exposes nothing that isn't already theirs.
 */
export function DiagnosticsView() {
  const authKey = useAuthKey();
  const { user } = useUser();
  const syncError = useProfileSync((s) => s.error);

  const [session, setSession] = useState<SessionState | null>(null);
  const [who, setWho] = useState<WhoAmI | null>(null);
  const [staffOperator, setStaffOperator] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const state = await ensureSession();
    setSession(state);
    if (state.status !== "ready") return;
    setWho(await whoami());
    setStaffOperator(await staffOperatorId());
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const clerkId = session?.status === "ready" ? session.userId : null;

  async function copy(value: string, key: string) {
    await navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied((k) => (k === key ? null : k)), 1600);
  }

  const roleOk = who?.jwt_role === "authenticated";

  return (
    <div className="flex max-w-[720px] flex-col gap-7">
      <SettingsGroup title="Services">
        <SettingsRow
          label="Supabase"
          description={isSupabaseConfigured ? "URL and key present" : "No URL or key set"}
          control={<Pill ok={isSupabaseConfigured} okLabel="Configured" badLabel="Not set" />}
        />
        <SettingsRow
          label="Clerk"
          description={
            session?.status === "ready"
              ? (user?.primaryEmailAddress?.emailAddress ?? "Signed in")
              : session?.status === "signed-out"
                ? "Not signed in"
                : session && "message" in session
                  ? session.message
                  : "Starting…"
          }
          control={<Pill ok={session?.status === "ready"} okLabel="Signed in" badLabel="No session" />}
        />
        <SettingsRow
          label="Profile row"
          description={
            syncError ?? (who?.has_profile ? "Identity mirrored into profiles." : "Not written yet.")
          }
          control={<Pill ok={who?.has_profile ?? false} okLabel="Saved" badLabel="Missing" />}
        />
        <SettingsRow
          label="Operator access"
          description={
            staffOperator
              ? "You can open /operator and advance orders."
              : "Not registered as an operator yet."
          }
          control={<Pill ok={Boolean(staffOperator)} okLabel="Yes" badLabel="No" />}
        />
      </SettingsGroup>

      <SettingsGroup title="What Postgres sees">
        <div className="p-4 lg:px-5">
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-[11.5px]">
            <dt className="text-muted">subject</dt>
            <dd className="m-0 truncate">{who?.clerk_sub ?? "(null)"}</dd>
            <dt className="text-muted">jwt role</dt>
            <dd className={cn("m-0", !roleOk && who && "text-clay-ink dark:text-clay")}>
              {who?.jwt_role ?? "—"}
            </dd>
            <dt className="text-muted">db role</dt>
            <dd className="m-0">{who?.pg_role ?? "—"}</dd>
          </dl>

          {who && !roleOk && (
            <p className="m-0 mt-3 flex items-start gap-2 rounded-xl bg-clay px-3 py-2.5 text-[11.5px] leading-relaxed text-clay-ink">
              <AlertCircle size={14} strokeWidth={2.2} className="mt-px shrink-0" />
              The token carries no <b>authenticated</b> role, so every RLS policy denies — including
              the one that creates your profile row. Turn on the Supabase integration in Clerk →
              Configure → Integrations.
            </p>
          )}
        </div>
      </SettingsGroup>

      {clerkId && (
        <SettingsGroup
          title="Become an operator"
          note="Run this once in the Supabase SQL editor, then reload /operator."
        >
          <div className="flex flex-col gap-3 p-4 lg:px-5">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-sunk px-2.5 py-2 font-mono text-[11.5px]">
                {clerkId}
              </code>
              <button
                onClick={() => copy(clerkId, "id")}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[12px] font-semibold text-ink-soft transition-colors hover:bg-surface-sunk"
              >
                <Copy size={12} strokeWidth={2.2} />
                {copied === "id" ? "Copied" : "Copy id"}
              </button>
            </div>

            <div className="relative">
              <pre className="overflow-x-auto rounded-xl border border-line bg-surface-sunk p-3 font-mono text-[11px] leading-relaxed">
{`insert into public.staff (user_id, operator_id)
values ('${clerkId}', (select id from public.operators limit 1));`}
              </pre>
              <button
                onClick={() =>
                  copy(
                    `insert into public.staff (user_id, operator_id)\nvalues ('${clerkId}', (select id from public.operators limit 1));`,
                    "sql",
                  )
                }
                className="absolute top-2 right-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft"
              >
                {copied === "sql" ? "Copied" : "Copy SQL"}
              </button>
            </div>
          </div>
        </SettingsGroup>
      )}
    </div>
  );
}

function Pill({
  ok,
  okLabel,
  badLabel,
}: {
  ok: boolean | undefined;
  okLabel: string;
  badLabel: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-semibold whitespace-nowrap",
        ok ? "bg-sage text-sage-ink" : "bg-clay text-clay-ink",
      )}
    >
      {ok ? <CircleCheck size={12} strokeWidth={2.4} /> : <CircleSlash size={12} strokeWidth={2.4} />}
      {ok ? okLabel : badLabel}
    </span>
  );
}

/**
 * Claiming the first admin seat.
 *
 * Only rendered while nobody holds it. Doing this in the app rather than the
 * SQL editor removes the one setup step that had no in-app path — and the
 * database refuses a second claim, so the button can't grant anything later.
 */
export function ClaimAdmin() {
  const authKey = useAuthKey();
  const [state, setState] = useState<
    "checking" | "open" | "claimed" | "held-by-other" | "signed-out"
  >("checking");
  const [clerkId, setClerkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const session = await ensureSession();
    if (session.status !== "ready") return setState("signed-out");
    setClerkId(session.userId);

    if (!(await adminsExist())) return setState("open");
    // Somebody holds it. Whether that's you is the useful distinction — a seat
    // taken by a mistyped row looks identical to no seat at all otherwise.
    setState((await isAdmin()) ? "claimed" : "held-by-other");
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "checking" || state === "signed-out") return null;

  if (state === "held-by-other") {
    return (
      <SettingsGroup
        title="Admin"
        note="Run this in the Supabase SQL editor to see who holds it, and to take it over if that row is wrong."
      >
        <div className="p-4 lg:px-5">
          <p className="m-0 flex items-center gap-2 text-[13.5px] font-semibold">
            <CircleSlash size={15} strokeWidth={2.4} />
            Admin is held by a different account
          </p>
          <p className="m-0 mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed text-muted">
            The seat is taken, so it can&apos;t be claimed here. If it was filled in by mistake —
            a placeholder pasted instead of a real id — replace it:
          </p>
          <pre className="mt-2.5 overflow-x-auto rounded-xl border border-line bg-surface-sunk p-3 font-mono text-[11px] leading-relaxed">
{`select * from public.admins;

delete from public.admins where user_id not like 'user\_%';
insert into public.admins (user_id)
values ('${clerkId ?? "user_..."}')
on conflict (user_id) do nothing;`}
          </pre>
        </div>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Admin"
      note="Only offered while nobody is an admin yet. Claim it now — on a public deployment the first person to sign in could otherwise take it."
    >
      <div className="p-4 lg:px-5">
        {state === "claimed" ? (
          <p className="m-0 flex items-center gap-2 text-[13.5px] font-semibold">
            <CircleCheck size={15} strokeWidth={2.4} />
            You&apos;re an admin. Open /admin to create desks and hand out owner codes.
          </p>
        ) : (
          <>
            <p className="m-0 mb-3 max-w-[60ch] text-[12.5px] leading-relaxed text-muted">
              Admins create desks and hand their owners a join code. Nobody holds it yet.
            </p>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setState((await claimFirstAdmin()) ? "claimed" : "held-by-other");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn't claim it.");
                } finally {
                  setBusy(false);
                }
              }}
              className="flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-semibold text-paper disabled:opacity-60"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Make me an admin
            </button>
          </>
        )}
        {error && <p className="m-0 mt-2.5 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
      </div>
    </SettingsGroup>
  );
}
