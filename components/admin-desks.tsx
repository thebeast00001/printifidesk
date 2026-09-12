"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Loader2, Plus, Ticket, UserRoundCheck, Users, X } from "lucide-react";
import { adminDesks, createDesk, type Desk } from "@/lib/operator";
import { createInvite, runDeskMyself } from "@/lib/desk";
import { useRouter } from "next/navigation";
import { useSurface } from "./surface-provider";
import { InviteCard } from "./operator/invite-card";
import { useAuthKey } from "@/hooks/use-auth-key";
import { cn, easeIos } from "@/lib/utils";

/**
 * Desks, and the codes that bring their first person in.
 *
 * A desk is created by an admin who already knows the shop; there's no form
 * for a stranger. Creating one gives you an owner code to hand over on
 * WhatsApp or across a counter — the owner's own sign-in claims it, and from
 * then on they add their own staff the same way. Only admins can call any of
 * this, enforced in the functions rather than in this component; the gate
 * around the page only decides what to draw.
 */
export function AdminDesks() {
  const authKey = useAuthKey();
  const router = useRouter();
  const { desk: deskPath } = useSurface();
  const [desks, setDesks] = useState<Desk[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [campus, setCampus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDesks(await adminDesks());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't list desks.");
      setDesks([]);
    }
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy("create");
    setError(null);
    try {
      const id = await createDesk(name, campus);
      await createInvite(id, "Owner");
      setName("");
      setCampus("");
      setCreating(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the desk.");
    } finally {
      setBusy(null);
    }
  }

  // Only for a desk nobody is on yet. Once the owner has joined, staff is the
  // desk's business; the database refuses an admin's code from then on. A
  // new code cancels the desk's earlier one — there's only ever one live.
  async function ownerCode(desk: Desk) {
    setBusy(desk.id);
    setError(null);
    try {
      await createInvite(desk.id, "Owner");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make a code.");
    } finally {
      setBusy(null);
    }
  }

  // The admin running an empty desk themselves — a founder who is also the
  // counter. A code, claimed at once, then straight to the queue.
  async function runMyself(desk: Desk) {
    setBusy(`run:${desk.id}`);
    setError(null);
    try {
      await runDeskMyself(desk.id);
      router.push(deskPath("/operator"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't take the desk.");
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-[12.5px] text-muted">
          {desks === null ? "" : desks.length === 0 ? "No desks yet." : `${desks.length} desk${desks.length === 1 ? "" : "s"}.`}
        </p>
        {!creating && (
          <button
            onClick={() => {
              setCreating(true);
              setError(null);
            }}
            className="flex h-10 items-center gap-1.5 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper"
          >
            <Plus size={14} strokeWidth={2.4} />
            New desk
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {creating && (
          <motion.form
            key="new"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: easeIos }}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
            className="overflow-hidden"
          >
            <div className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
              <p className="m-0 text-[13px] font-semibold">A new desk</p>
              <p className="m-0 mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-muted">
                Closed and unstaffed until its owner joins. You get a code to hand them; the rest —
                prices, hours, UPI, who else works there — is theirs.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1.4fr_1fr_auto_auto]">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  placeholder="What students see — e.g. Sharma Xerox, Block C"
                  className="h-11 min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[13px] outline-none focus:border-ink"
                />
                <input
                  value={campus}
                  onChange={(e) => setCampus(e.target.value)}
                  maxLength={120}
                  placeholder="Campus"
                  className="h-11 min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[13px] outline-none focus:border-ink"
                />
                <button
                  type="submit"
                  disabled={busy === "create" || !name.trim() || !campus.trim()}
                  className="flex h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-40"
                >
                  {busy === "create" ? <Loader2 size={14} className="animate-spin" /> : <Ticket size={14} strokeWidth={2.2} />}
                  Create, get owner code
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  aria-label="Cancel"
                  className="grid h-11 w-11 place-items-center justify-self-start rounded-xl border border-line text-muted"
                >
                  <X size={15} strokeWidth={2.2} />
                </button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {error && (
        <p className="m-0 flex items-start gap-2 rounded-[14px] bg-clay px-4 py-3 text-[12.5px] text-clay-ink">
          <AlertCircle size={15} strokeWidth={2.2} className="mt-px shrink-0" />
          {error}
        </p>
      )}

      {desks === null ? (
        <Panel>
          <Loader2 size={15} className="animate-spin" />
          Loading…
        </Panel>
      ) : (
        desks.map((desk) => (
          <article key={desk.id} className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{desk.name}</h3>
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[10.5px] font-semibold",
                      desk.staff_count === 0
                        ? "bg-bone text-ink"
                        : desk.is_open
                          ? "bg-sage text-sage-ink"
                          : "bg-surface-sunk text-muted",
                    )}
                  >
                    {desk.staff_count === 0 ? "waiting for owner" : desk.is_open ? "open" : "closed"}
                  </span>
                </div>
                <p className="m-0 mt-1.5 text-[12.5px] text-muted">{desk.campus}</p>
                <p className="m-0 mt-1 flex items-center gap-1.5 font-mono text-[11.5px] text-muted">
                  <Users size={12} strokeWidth={2.2} />
                  {desk.staff_count} on staff
                  {desk.open_invites > 0 && ` · ${desk.open_invites} code${desk.open_invites === 1 ? "" : "s"} open`}
                </p>
              </div>
              {desk.staff_count === 0 ? (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    onClick={() => ownerCode(desk)}
                    disabled={busy !== null}
                    className="flex h-10 items-center gap-1.5 rounded-xl border border-line bg-surface-sunk px-3.5 text-[12.5px] font-semibold text-ink-soft disabled:opacity-50"
                  >
                    {busy === desk.id ? <Loader2 size={13} className="animate-spin" /> : <Ticket size={14} strokeWidth={2.2} />}
                    {desk.owner_code ? "New owner code" : "Owner code"}
                  </button>
                  <button
                    onClick={() => runMyself(desk)}
                    disabled={busy !== null}
                    title="Put your own account on this desk and open its queue"
                    className="flex h-10 items-center gap-1.5 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper disabled:opacity-50"
                  >
                    {busy === `run:${desk.id}` ? <Loader2 size={13} className="animate-spin" /> : <UserRoundCheck size={14} strokeWidth={2.2} />}
                    Run it myself
                  </button>
                </div>
              ) : (
                <p className="m-0 shrink-0 text-[11.5px] text-muted">Staff is theirs to manage.</p>
              )}
            </div>

            {/* The live owner code stays readable here until the owner joins —
                a lost message is re-read, not re-minted. */}
            {desk.staff_count === 0 && desk.owner_code && desk.owner_code_expires_at && (
              <InviteCard
                code={desk.owner_code}
                expiresAt={desk.owner_code_expires_at}
                label="Owner code"
                who="The owner"
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
