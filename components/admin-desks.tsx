"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Loader2, Plus, ShieldAlert, Ticket, Users, X } from "lucide-react";
import { adminDesks, adminsExist, createDesk, isAdmin, type Desk } from "@/lib/operator";
import { createInvite } from "@/lib/desk";
import { InviteCard } from "./operator/invite-card";
import { AdminFees } from "./admin-fees";
import { useAuthKey } from "@/hooks/use-auth-key";
import { ensureSession } from "@/lib/supabase/client";
import { cn, easeIos } from "@/lib/utils";

/**
 * Desks, and the codes that bring their first person in.
 *
 * A desk is created by an admin who already knows the shop; there's no form
 * for a stranger. Creating one gives you an owner code to hand over on
 * WhatsApp or across a counter — the owner's own sign-in claims it, and from
 * then on they add their own staff the same way. Only admins can call any of
 * this, enforced in the functions rather than in this component.
 */
export function AdminDesks() {
  const authKey = useAuthKey();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [clerkId, setClerkId] = useState<string | null>(null);
  const [seatTaken, setSeatTaken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [desks, setDesks] = useState<Desk[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [campus, setCampus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The code just made, shown under the desk it belongs to.
  const [fresh, setFresh] = useState<{ deskId: string; code: string; expires_at: string } | null>(null);

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
    if (allowed) {
      try {
        setDesks(await adminDesks());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't list desks.");
        setDesks([]);
      }
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
      const made = await createInvite(id, "Owner");
      setFresh({ deskId: id, ...made });
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
  // desk's business; the database refuses an admin's code from then on.
  async function ownerCode(desk: Desk) {
    setBusy(desk.id);
    setError(null);
    try {
      const made = await createInvite(desk.id, "Owner");
      setFresh({ deskId: desk.id, ...made });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make a code.");
    } finally {
      setBusy(null);
    }
  }

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
              ? "Someone else holds admin. Admin is granted only in the Supabase SQL editor, by whoever owns the project — if that row was filled in by mistake, they replace it with this:"
              : "Nobody is an admin yet. Admin is granted only in the Supabase SQL editor, by whoever owns the project — if that's you, run this:"}
        </p>
        {signedIn && clerkId && <AdminFixSql clerkId={clerkId} seatTaken={seatTaken} copied={copied} setCopied={setCopied} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AdminFees />

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
                <button
                  onClick={() => ownerCode(desk)}
                  disabled={busy === desk.id}
                  className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-surface-sunk px-3.5 text-[12.5px] font-semibold text-ink-soft disabled:opacity-50"
                >
                  {busy === desk.id ? <Loader2 size={13} className="animate-spin" /> : <Ticket size={14} strokeWidth={2.2} />}
                  Owner code
                </button>
              ) : (
                <p className="m-0 shrink-0 text-[11.5px] text-muted">Staff is theirs to manage.</p>
              )}
            </div>

            {fresh?.deskId === desk.id && desk.staff_count === 0 && (
              <InviteCard
                code={fresh.code}
                expiresAt={fresh.expires_at}
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
delete from public.admins where user_id not like 'user\\_%';
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
