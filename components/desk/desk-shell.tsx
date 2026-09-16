"use client";

import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { AlertCircle, ChevronDown, Loader2, LogIn, UserRoundCheck } from "lucide-react";
import { useConnectionVerdict } from "../connection-banner";
import { DeskSignIn } from "../operator/desk-sign-in";
import { JoinDesk } from "../join-desk";
import { useSurface } from "../surface-provider";
import { useDesk } from "./desk-provider";
import { OpenSwitch } from "./open-switch";
import { SupportLine } from "../support-line";
import { cn } from "@/lib/utils";

/**
 * Routes between the states someone can be in on the desk site: not signed
 * in, signed in but on no desk, or running one — and, for the last, draws
 * the header every desk page shares.
 */
export function DeskShell({ children }: { children: React.ReactNode }) {
  const { backend, operatorId, operator, operatorIds, deskNames, reload, paired, chooseDesk } = useDesk();
  const { verdict } = useConnectionVerdict();
  const { surface, split, desk } = useSurface();
  const clerk = useClerk();

  if (backend.state === "loading") {
    return <Notice icon={<Loader2 size={16} className="animate-spin" />} title="Opening…" />;
  }

  if (backend.state === "signed-out") {
    // A paired desk: the shift starts with a name and a PIN. Anything else:
    // the desk's own door — email and password, never the student's modal.
    if (paired) return <DeskSignIn />;
    return (
      <div className="rounded-[20px] border border-line bg-surface p-6 text-center shadow-card">
        <p className="m-0 text-[14px] font-semibold tracking-[-0.01em]">Sign in to the desk</p>
        <p className="mx-auto m-0 mt-1.5 max-w-[44ch] text-[12.5px] leading-relaxed text-muted">
          Your desk account — email and password. A counter device that&apos;s been paired opens
          straight to the staff list instead.
        </p>
        <Link
          href={surface === "desk" ? "/sign-in" : "/sign-in?desk=1"}
          className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper"
        >
          <LogIn size={14} strokeWidth={2.2} />
          Sign in
        </Link>
      </div>
    );
  }

  if (backend.state === "unconfigured") {
    return <Notice tone="clay" title="No backend configured" body={backend.message} />;
  }

  if (backend.state === "error") {
    return <Notice tone="clay" title="Can't reach the database" body={backend.message} />;
  }

  // Not staff anywhere. The only way onto a desk is a code from whoever runs
  // it, so that's what this account is offered.
  if (!operatorId || !operator) {
    // A rejected token also produces "no operator"; the banner above already
    // explains that, so don't ask for a code on top of it.
    if (verdict.kind === "blocked") return null;
    if (verdict.kind === "checking") {
      return <Notice icon={<Loader2 size={16} className="animate-spin" />} title="Checking access…" />;
    }
    return <JoinDesk onJoined={() => void reload()} />;
  }

  return (
    <div className="flex flex-col gap-4" data-anim="board">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {operatorIds.length > 1 ? (
            // On more than one desk: the name is a picker.
            <label className="relative block">
              <span className="sr-only">Which desk</span>
              <select
                value={operatorId}
                onChange={(e) => chooseDesk(e.target.value)}
                className="font-heading m-0 appearance-none bg-transparent pr-6 text-[20px] font-bold outline-none"
              >
                {operatorIds.map((id) => (
                  <option key={id} value={id}>
                    {id === operator.id ? operator.short_name || operator.name : (deskNames[id] ?? "…")}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                strokeWidth={2.4}
                className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 text-muted"
              />
            </label>
          ) : (
            <h2 className="font-heading m-0 text-[20px] font-bold">{operator.short_name || operator.name}</h2>
          )}
          <p className="m-0 mt-0.5 text-[12.5px] text-muted">{operator.campus}</p>
        </div>

        <div className="flex items-center gap-2">
          {paired && (
            <button
              onClick={() => void clerk.signOut({ redirectUrl: desk("/operator") })}
              title="End your shift — the next person taps their name"
              className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-surface-sunk"
            >
              <UserRoundCheck size={14} strokeWidth={2.2} />
              <span className="hidden sm:inline">Switch staff</span>
            </button>
          )}
          <OpenSwitch operator={operator} onChanged={reload} compact />
        </div>
      </div>

      {operator.shut_at && (
        <Notice
          tone="clay"
          title={`Closed by Printify on ${new Date(operator.shut_at).toLocaleDateString("en-IN", { day: "numeric", month: "long" })}`}
          body={`${operator.shut_reason ?? ""} — Students can't see this desk or send it anything new. Orders already placed are still yours to hand over or refund; the Printify fee on them is still settled from Takings. Nobody can be added and the desk can't be opened until Printify restores it.`}
        />
      )}

      {children}

      <SupportLine desk deskName={operator.short_name || operator.name} />

      {!split && surface === "student" && (
        // One host, both sites: a deliberate way back. On its own host the
        // desk has no student side to go to.
        <p className="m-0 text-[11.5px] text-muted">
          <Link href="/" className="font-semibold underline-offset-2 hover:underline">
            Student side
          </Link>
        </p>
      )}
    </div>
  );
}

function Notice({
  icon,
  title,
  body,
  tone,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  tone?: "clay";
}) {
  return (
    <div
      className={cn(
        "rounded-[18px] border p-4 lg:p-5",
        tone === "clay" ? "border-clay bg-clay/25" : "border-line bg-surface",
      )}
    >
      <p className="m-0 flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em]">
        {icon ?? (tone === "clay" ? <AlertCircle size={16} strokeWidth={2.2} /> : null)}
        {title}
      </p>
      {body && <p className="m-0 mt-1.5 text-[12.5px] leading-relaxed text-muted">{body}</p>}
    </div>
  );
}
