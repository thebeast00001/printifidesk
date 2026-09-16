"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Crown, Loader2, UserMinus, UserPlus, X } from "lucide-react";
import {
  createInvite,
  formatJoinCode,
  listStaff,
  openInvites,
  removeStaff,
  setStaffRole,
  revokeInvite,
  type StaffInvite,
  type StaffMember,
} from "@/lib/desk";
import type { Operator } from "@/lib/orders";
import { forgetStaffNames } from "./handled-by";
import { InviteCard, expiryText } from "./invite-card";
import { useNow } from "./age";
import { cn, easeIos } from "@/lib/utils";

/**
 * Who can run this desk.
 *
 * Adding someone is a join code: make one, they open it on their own phone,
 * sign in once, and they're on the list with the name from their account.
 * No email to ask for, nothing to spell. The last person can't remove
 * themselves — a desk with nobody on it can never be reopened from the app.
 */
export function StaffPanel({ operator, me, role = "owner" }: { operator: Operator; me: string | null; role?: "owner" | "staff" }) {
  const owner = role === "owner";
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [invites, setInvites] = useState<StaffInvite[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [asRole, setAsRole] = useState<"owner" | "staff">("staff");
  const [fresh, setFresh] = useState<{ code: string; expires_at: string; label: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    forgetStaffNames(operator.id);
    const [people, open] = await Promise.all([listStaff(operator.id), openInvites(operator.id)]);
    setStaff(people);
    setInvites(open);
  }, [operator.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function makeCode() {
    setBusy("add");
    setError(null);
    try {
      const made = await createInvite(operator.id, label, asRole);
      setFresh({ ...made, label: label.trim() });
      setAsRole("staff");
      setLabel("");
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make a code.");
    } finally {
      setBusy(null);
    }
  }

  async function cancel(inv: StaffInvite) {
    setBusy(inv.id);
    setError(null);
    try {
      await revokeInvite(inv.id);
      if (fresh?.code === inv.code) setFresh(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't cancel that code.");
    } finally {
      setBusy(null);
    }
  }

  async function changeRole(userId: string, to: "owner" | "staff") {
    setBusy(userId);
    setError(null);
    try {
      await setStaffRole(operator.id, userId, to);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change that role.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(userId: string) {
    setBusy(userId);
    setError(null);
    try {
      await removeStaff(operator.id, userId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove them.");
    } finally {
      setBusy(null);
    }
  }

  // Codes still open, minus the one shown large above the list.
  const others = invites.filter((i) => i.code !== fresh?.code);

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-heading m-0 text-[18px] font-bold">Staff</h2>
          <p className="m-0 mt-1 text-[12.5px] text-muted">
            Staff run the queue and take payment. Owners also set rates, payments, hours, extras, staff and see the
            takings.
          </p>
        </div>
        {!adding && owner && (
          <button
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-ink px-3.5 text-[12.5px] font-semibold text-paper"
          >
            <UserPlus size={14} strokeWidth={2.2} />
            Add someone
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {adding && (
          <motion.form
            key="add"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: easeIos }}
            onSubmit={(e) => {
              e.preventDefault();
              void makeCode();
            }}
            className="overflow-hidden"
          >
            <div className="mt-3.5 rounded-[16px] border border-line bg-surface-sunk p-3.5">
              <p className="m-0 text-[12.5px] leading-relaxed text-muted">
                You get a code. They open it on their phone, sign in once, and they&apos;re in.
                The name is just so the list reads well — theirs comes from their account.
              </p>
              <div className="mt-2.5 flex gap-2">
                <input
                  autoFocus
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={60}
                  placeholder="Who is it for? (optional)"
                  className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] outline-none focus:border-ink"
                />
                <select
                  value={asRole}
                  onChange={(e) => setAsRole(e.target.value as "owner" | "staff")}
                  aria-label="Join as"
                  className="h-11 shrink-0 rounded-xl border border-line bg-surface px-2.5 text-[13px] outline-none focus:border-ink"
                >
                  <option value="staff">as staff</option>
                  <option value="owner">as an owner</option>
                </select>
                <button
                  type="submit"
                  disabled={busy === "add"}
                  className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-60"
                >
                  {busy === "add" ? <Loader2 size={14} className="animate-spin" /> : null}
                  Make a code
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setLabel("");
                  }}
                  aria-label="Cancel"
                  className="grid size-11 shrink-0 place-items-center rounded-xl border border-line text-muted"
                >
                  <X size={15} strokeWidth={2.2} />
                </button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {fresh && (
        <InviteCard
          code={fresh.code}
          expiresAt={fresh.expires_at}
          label={fresh.label || "New join code"}
          who={fresh.label || undefined}
          className="mt-3.5"
        />
      )}

      <div className="mt-3.5">
        {staff === null ? (
          <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
            <Loader2 size={15} className="animate-spin" />
            Loading…
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {staff.map((s) => (
              <li
                key={s.user_id}
                className="flex items-center gap-3 rounded-xl border border-line bg-surface-sunk px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-[13px] font-semibold">
                    {s.name ?? s.email ?? s.user_id}
                    {s.user_id === me && <span className="font-normal text-muted">(you)</span>}
                    {(s.role ?? "owner") === "owner" && (
                      <span className="flex items-center gap-1 rounded-full bg-bone px-2 py-0.5 text-[10.5px] font-semibold text-ink">
                        <Crown size={10} strokeWidth={2.4} />
                        owner
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted">
                    {s.email && s.name ? `${s.email} · ` : ""}
                    {s.has_pin ? "PIN set" : "no PIN — can't use desk sign-in yet"}
                  </span>
                </span>
                {owner && (
                  <button
                    onClick={() => changeRole(s.user_id, (s.role ?? "owner") === "owner" ? "staff" : "owner")}
                    disabled={busy === s.user_id}
                    className="h-9 shrink-0 rounded-lg border border-line px-2.5 text-[11.5px] font-semibold text-muted transition-colors hover:text-ink disabled:opacity-40"
                  >
                    {(s.role ?? "owner") === "owner" ? "Make staff" : "Make owner"}
                  </button>
                )}
                {owner && (
                  <button
                    onClick={() => remove(s.user_id)}
                    disabled={busy === s.user_id || staff.length <= 1}
                    title={staff.length <= 1 ? "The last person can't leave" : "Remove"}
                    aria-label={`Remove ${s.name ?? s.email ?? "this person"}`}
                    className="grid size-9 shrink-0 place-items-center rounded-lg border border-line text-muted transition-colors hover:text-ink disabled:opacity-40"
                  >
                    {busy === s.user_id ? <Loader2 size={13} className="animate-spin" /> : <UserMinus size={14} strokeWidth={2.2} />}
                  </button>
                )}
              </li>
            ))}

            {others.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">
                    {inv.label ?? "Join code"}
                    <span className="ml-1.5 font-normal text-muted">not joined yet</span>
                  </span>
                  <span className="block font-mono text-[11px] tracking-[0.08em] text-muted">
                    {formatJoinCode(inv.code)} · {expiryText(inv.expires_at, now)}
                  </span>
                </span>
                <button
                  onClick={() => cancel(inv)}
                  disabled={busy === inv.id}
                  title="Cancel this code"
                  aria-label={`Cancel the code for ${inv.label ?? "this person"}`}
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-lg border border-line text-muted transition-colors hover:text-ink disabled:opacity-40",
                  )}
                >
                  {busy === inv.id ? <Loader2 size={13} className="animate-spin" /> : <X size={14} strokeWidth={2.2} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="m-0 mt-2.5 text-[11px] leading-relaxed text-muted">
        Whoever joins gets exactly what you have — there is no read-only role yet. A code works
        once and for a day.
      </p>
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </section>
  );
}
