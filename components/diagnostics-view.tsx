"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { AlertCircle, CircleCheck, CircleSlash, Copy } from "lucide-react";
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
import { adminsExist, isAdmin } from "@/lib/operator";
import { useSurface } from "./surface-provider";
import { MIGRATION_PROBES, probeMigrations, type MigrationReport } from "@/lib/migrations";
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
      <DeploymentGroup />
      <MigrationsGroup />

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
 * How admin is granted: by hand, in the Supabase SQL editor, by whoever owns
 * the project. There is deliberately no button. The section shows the exact
 * INSERT with the signed-in account's real id, because a placeholder pasted
 * into the editor is how a wrong row ends up in the table.
 */
export function ClaimAdmin() {
  const authKey = useAuthKey();
  const [state, setState] = useState<
    "checking" | "open" | "claimed" | "held-by-other" | "signed-out"
  >("checking");
  const [clerkId, setClerkId] = useState<string | null>(null);

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

  if (state === "claimed") {
    return (
      <SettingsGroup title="Admin" note="Admins create desks and hand their owners a join code. Nothing else.">
        <div className="p-4 lg:px-5">
          <p className="m-0 flex items-center gap-2 text-[13.5px] font-semibold">
            <CircleCheck size={15} strokeWidth={2.4} />
            You&apos;re the admin. Open /admin to create desks.
          </p>
        </div>
      </SettingsGroup>
    );
  }

  const held = state === "held-by-other";
  return (
    <SettingsGroup
      title="Admin"
      note="There is no button for this, on purpose. Admin is granted only in the Supabase SQL editor, by whoever owns the project."
    >
      <div className="p-4 lg:px-5">
        <p className="m-0 flex items-center gap-2 text-[13.5px] font-semibold">
          <CircleSlash size={15} strokeWidth={2.4} />
          {held ? "Admin is held by a different account" : "Nobody is an admin yet"}
        </p>
        <p className="m-0 mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed text-muted">
          {held
            ? "If that row was filled in by mistake — a placeholder pasted instead of a real id — the project owner replaces it with this account:"
            : "If this is your project, run this in Supabase → SQL Editor and this account becomes the admin:"}
        </p>
        <pre className="mt-2.5 overflow-x-auto rounded-xl border border-line bg-surface-sunk p-3 font-mono text-[11px] leading-relaxed">
{held
  ? `select * from public.admins;

delete from public.admins where user_id not like 'user\\_%';
insert into public.admins (user_id)
values ('${clerkId ?? "user_..."}')
on conflict (user_id) do nothing;`
  : `insert into public.admins (user_id)
values ('${clerkId ?? "user_..."}');`}
        </pre>
      </div>
    </SettingsGroup>
  );
}

/**
 * What this deployment thinks it is. Two of the ways the two-site setup
 * fails are silent — a desk project without the student host, or two
 * projects with different VAPID pairs — and both are visible here: compare
 * this block on the two sites.
 */
/**
 * Which migrations the live project has run — probed, not assumed. A
 * migration applied out of order shows up here as the earlier one
 * missing, with what breaks while it is.
 */
function MigrationsGroup() {
  const [report, setReport] = useState<MigrationReport | null>(null);
  useEffect(() => {
    void probeMigrations().then(setReport);
  }, []);
  const ok = report !== null && report.missing.length === 0;
  return (
    <SettingsGroup
      title="Database migrations"
      note={
        report === null
          ? "Checking which migrations the project has run…"
          : ok
            ? `All ${MIGRATION_PROBES.length} probed migrations are in.`
            : "Run the missing ones in the SQL editor, in number order — a later migration can name a column an earlier one adds."
      }
    >
      {report?.missing.map((m) => (
        <SettingsRow
          key={m.id}
          label={`${m.id} missing`}
          description={`Without it: ${m.without}`}
          control={<Pill ok={false} okLabel="in" badLabel="missing" />}
        />
      ))}
      {report && ok && (
        <SettingsRow
          label={`0022 → ${MIGRATION_PROBES[MIGRATION_PROBES.length - 1].id}`}
          description="Every column and function the app expects answered."
          control={<Pill ok okLabel="in" badLabel="missing" />}
        />
      )}
    </SettingsGroup>
  );
}

function DeploymentGroup() {
  const { surface, split } = useSurface();
  const desk = process.env.NEXT_PUBLIC_DESK_HOST || "";
  const site = process.env.NEXT_PUBLIC_SITE_HOST || "";
  const pin = process.env.NEXT_PUBLIC_SURFACE || "";
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
  const pinnedDeskWithoutSite = pin === "desk" && !site;

  return (
    <SettingsGroup
      title="This deployment"
      note="Compare with the other site's page: the hosts should match, and the VAPID key must be identical or pushes from one will be refused for the other."
    >
      <SettingsRow
        label="Site"
        description={`${surface === "desk" ? "The desk" : "The student site"}${pin ? " — pinned by NEXT_PUBLIC_SURFACE" : split ? " — by host" : " — single host, nothing pinned"}`}
        control={<Pill ok={!pinnedDeskWithoutSite} okLabel={surface} badLabel="pinned desk, no student host" />}
      />
      <SettingsRow
        label="Hosts"
        description={split ? `desk ${desk} · student ${site || "(derived)"}` : "NEXT_PUBLIC_DESK_HOST not set — both sites share this host"}
        control={<Pill ok={split || surface === "student"} okLabel={split ? "split" : "single"} badLabel="unset" />}
      />
      <SettingsRow
        label="VAPID key"
        description={vapid ? `…${vapid.slice(-12)}` : "NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set — no push"}
        control={<Pill ok={Boolean(vapid)} okLabel="set" badLabel="missing" />}
      />
    </SettingsGroup>
  );
}

