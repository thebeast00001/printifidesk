"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Check, Loader2, ShieldAlert, X } from "lucide-react";
import {
  approveApplication,
  adminsExist,
  isAdmin,
  listApplications,
  rejectApplication,
  type Application,
  type ApplicationStatus,
} from "@/lib/operator";
import { useAuthKey } from "@/hooks/use-auth-key";
import { ensureSession } from "@/lib/supabase/client";
import { cn, spring } from "@/lib/utils";

const FILTERS: { id: ApplicationStatus | "all"; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

/**
 * Reviewing operator applications.
 *
 * Approving isn't a status flip — `approve_application()` creates the operator
 * and the staff row in one transaction, so a half-approved application can't
 * exist. Only admins can call it, enforced in the function itself rather than
 * in this component.
 */
export function AdminApplications() {
  const authKey = useAuthKey();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [clerkId, setClerkId] = useState<string | null>(null);
  const [seatTaken, setSeatTaken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState<ApplicationStatus | "all">("pending");
  const [rows, setRows] = useState<Application[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const session = await ensureSession();
    if (session.status !== "ready") {
      setSignedIn(session.status !== "signed-out");
      setAdmin(false);
      return;
    }
    setClerkId(session.userId);
    setSeatTaken(await adminsExist());
    const allowed = await isAdmin();
    setAdmin(allowed);
    if (allowed) setRows(await listApplications(filter === "all" ? undefined : filter));
  }, [authKey, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  if (admin === null) {
    return (
      <Panel>
        <Loader2 size={15} className="animate-spin" />
        Checking access…
      </Panel>
    );
  }

  if (!admin) {
    return (
      <div className="rounded-[20px] border border-clay bg-clay/25 p-5">
        <p className="m-0 flex items-center gap-2 text-[15px] font-semibold">
          <ShieldAlert size={17} strokeWidth={2.2} />
          {signedIn ? "You're not an admin" : "Sign in to continue"}
        </p>
        <p className="m-0 mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed text-ink-soft">
          {!signedIn
            ? "Admins sign in with the same account everyone else uses."
            : seatTaken
              ? "Someone already holds admin, so it can't be claimed from /diagnostics. If that row was filled in by mistake, replace it below."
              : "Nobody is an admin yet — you can take the seat from /diagnostics with one button, or run this."}
        </p>
        {signedIn && clerkId && <AdminFixSql clerkId={clerkId} seatTaken={seatTaken} copied={copied} setCopied={setCopied} />}
      </div>
    );
  }

  async function run(id: string, action: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await action();
      setRejecting(null);
      setReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "relative rounded-full px-3.5 py-2 text-[13px] font-semibold transition-colors",
              filter === f.id ? "text-paper" : "text-muted hover:text-ink-soft",
            )}
          >
            {filter === f.id && (
              <motion.span
                layoutId="admin-filter"
                transition={spring}
                className="absolute inset-0 rounded-full bg-ink"
              />
            )}
            <span className="relative">{f.label}</span>
          </button>
        ))}
      </div>

      {error && (
        <p className="m-0 flex items-start gap-2 rounded-[14px] bg-clay px-4 py-3 text-[12.5px] text-clay-ink">
          <AlertCircle size={15} strokeWidth={2.2} className="mt-px shrink-0" />
          {error}
        </p>
      )}

      {rows === null ? (
        <Panel>
          <Loader2 size={15} className="animate-spin" />
          Loading…
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>Nothing here.</Panel>
      ) : (
        rows.map((app) => (
          <article
            key={app.id}
            className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
                    {app.display_name}
                  </h3>
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[10.5px] font-semibold",
                      app.status === "pending"
                        ? "bg-bone text-ink"
                        : app.status === "approved"
                          ? "bg-sage text-sage-ink"
                          : "bg-clay text-clay-ink",
                    )}
                  >
                    {app.status}
                  </span>
                </div>
                <p className="m-0 mt-1.5 text-[12.5px] text-muted">
                  {app.campus}
                  {app.location ? ` · ${app.location}` : ""}
                </p>
                <p className="m-0 mt-0.5 font-mono text-[11.5px] text-muted">
                  {app.phone}
                  {app.machine ? ` · ${app.machine}` : ""}
                </p>
                {app.note && (
                  <p className="m-0 mt-2 max-w-[60ch] text-[12.5px] leading-relaxed">{app.note}</p>
                )}
                {app.review_note && (
                  <p className="m-0 mt-2 text-[12px] text-muted">Review note: {app.review_note}</p>
                )}
                <p className="m-0 mt-2 font-mono text-[11px] text-faint">
                  {app.user_id} · {new Date(app.created_at).toLocaleString()}
                </p>
              </div>

              {app.status === "pending" && (
                <div className="flex shrink-0 gap-2">
                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    transition={spring}
                    disabled={busy === app.id}
                    onClick={() => run(app.id, () => approveApplication(app.id))}
                    className="flex h-10 items-center gap-1.5 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper disabled:opacity-50"
                  >
                    {busy === app.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Check size={14} strokeWidth={2.6} />
                    )}
                    Approve
                  </motion.button>
                  <button
                    disabled={busy === app.id}
                    onClick={() => setRejecting(rejecting === app.id ? null : app.id)}
                    className="flex h-10 items-center gap-1.5 rounded-xl border border-line bg-surface-sunk px-3.5 text-[12.5px] font-semibold text-ink-soft disabled:opacity-50"
                  >
                    <X size={14} strokeWidth={2.4} />
                    Reject
                  </button>
                </div>
              )}
            </div>

            {rejecting === app.id && (
              <div className="mt-3.5 flex flex-wrap gap-2 border-t border-line pt-3.5">
                <input
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why — the applicant sees this"
                  className="min-w-0 flex-1 rounded-xl border border-line bg-surface-sunk px-3 py-2.5 text-[13px] outline-none focus:border-ink"
                />
                <button
                  disabled={!reason.trim() || busy === app.id}
                  onClick={() => run(app.id, () => rejectApplication(app.id, reason.trim()))}
                  className="rounded-xl bg-clay px-4 py-2.5 text-[12.5px] font-semibold text-clay-ink disabled:opacity-50"
                >
                  Send rejection
                </button>
              </div>
            )}
          </article>
        ))
      )}
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[20px] border border-line bg-surface p-4 text-[13px] text-muted lg:p-5">
      {children}
    </div>
  );
}

/**
 * The repair statement, with the signed-in user's real id already in it.
 *
 * This block previously printed a `<your id>` placeholder, which is exactly how
 * a literal placeholder ends up in the admins table — blocking both the button
 * and access. Never show a fill-in-the-blank for something copied into a SQL
 * editor.
 */
function AdminFixSql({
  clerkId,
  seatTaken,
  copied,
  setCopied,
}: {
  clerkId: string;
  seatTaken: boolean;
  copied: boolean;
  setCopied: (v: boolean) => void;
}) {
  const sql = seatTaken
    ? `-- see who holds it
select * from public.admins;

-- drop any row that isn't a real Clerk id, then take the seat
delete from public.admins where user_id not like 'user\_%';
insert into public.admins (user_id)
values ('${clerkId}')
on conflict (user_id) do nothing;`
    : `insert into public.admins (user_id)
values ('${clerkId}');`;

  return (
    <div className="relative mt-3">
      <pre className="overflow-x-auto rounded-xl border border-line bg-surface p-3 pr-24 font-mono text-[11px] leading-relaxed">
        {sql}
      </pre>
      <button
        onClick={async () => {
          await navigator.clipboard?.writeText(sql);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        className="absolute top-2 right-2 rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft"
      >
        {copied ? "Copied" : "Copy SQL"}
      </button>
    </div>
  );
}
