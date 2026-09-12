"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Check, Loader2, X } from "lucide-react";
import {
  adminApplications,
  approveApplication,
  rejectApplication,
  type Application,
  type ApplicationStatus,
} from "@/lib/operator";
import { InviteCard } from "./operator/invite-card";
import { useAuthKey } from "@/hooks/use-auth-key";
import { cn, spring } from "@/lib/utils";

const FILTERS: { id: ApplicationStatus | "all"; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

/**
 * Reading applications.
 *
 * Accepting isn't a status flip: `approve_application()` creates the desk
 * and mints an owner code for that applicant's account in one transaction,
 * so a half-approved application can't exist. The code comes back here for
 * the admin to hand over, and stays readable on the row until it's used.
 * Only the admin can call any of it, enforced in the functions.
 */
export function AdminApplications() {
  const authKey = useAuthKey();
  const [filter, setFilter] = useState<ApplicationStatus | "all">("pending");
  const [rows, setRows] = useState<Application[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await adminApplications(filter === "all" ? undefined : filter));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't list applications.");
      setRows([]);
    }
  }, [authKey, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(id: string, action: () => Promise<unknown>) {
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
              <motion.span layoutId="admin-filter" transition={spring} className="absolute inset-0 rounded-full bg-ink" />
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
          <article key={app.id} className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{app.display_name}</h3>
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
                    {app.status === "approved" && (app.code_claimed ? " · joined" : app.code ? " · code live" : " · code spent")}
                  </span>
                </div>
                <p className="m-0 mt-1.5 text-[12.5px] text-muted">
                  {app.campus}
                  {app.location ? ` · ${app.location}` : ""}
                </p>
                <p className="m-0 mt-0.5 font-mono text-[11.5px] text-muted">
                  {app.applicant_name ?? "—"}
                  {app.applicant_email ? ` · ${app.applicant_email}` : ""} · {app.phone}
                  {app.machine ? ` · ${app.machine}` : ""}
                </p>
                {app.note && <p className="m-0 mt-2 max-w-[60ch] text-[12.5px] leading-relaxed">{app.note}</p>}
                {app.review_note && <p className="m-0 mt-2 text-[12px] text-muted">Review note: {app.review_note}</p>}
                <p className="m-0 mt-2 font-mono text-[11px] text-faint">
                  {new Date(app.created_at).toLocaleString()}
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
                    {busy === app.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} strokeWidth={2.6} />}
                    Accept
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
                  maxLength={500}
                  placeholder="Why — the applicant sees this"
                  className="min-w-0 flex-1 rounded-xl border border-line bg-surface-sunk px-3 py-2.5 text-[13px] outline-none focus:border-ink"
                />
                <button
                  disabled={!reason.trim() || busy === app.id}
                  onClick={() => run(app.id, () => rejectApplication(app.id, reason))}
                  className="rounded-xl bg-clay px-4 py-2.5 text-[12.5px] font-semibold text-clay-ink disabled:opacity-50"
                >
                  Send rejection
                </button>
              </div>
            )}

            {/* The owner code: made for this applicant's account only, so it
                can travel by any channel. Stays here until it's used. */}
            {app.status === "approved" && app.code && app.code_expires_at && (
              <InviteCard
                code={app.code}
                expiresAt={app.code_expires_at}
                label={`Owner code · for ${app.applicant_name ?? app.applicant_email ?? "the applicant"} only`}
                who={app.applicant_name ?? "The applicant"}
                className="mt-3.5"
              />
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
