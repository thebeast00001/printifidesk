"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, UserMinus, UserPlus } from "lucide-react";
import { addStaff, listStaff, removeStaff, type StaffMember } from "@/lib/desk";
import type { Operator } from "@/lib/orders";
import { forgetStaffNames } from "./handled-by";
import { cn } from "@/lib/utils";

/**
 * Who can run this desk. Adding someone is by the email they signed in with;
 * they must have opened Printify once, because that is what creates the row
 * the lookup finds. The last person can't remove themselves — a desk with
 * nobody on it can never be reopened from the app.
 */
export function StaffPanel({ operator, me }: { operator: Operator; me: string | null }) {
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    forgetStaffNames(operator.id);
    setStaff(await listStaff(operator.id));
  }, [operator.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!email.trim()) return;
    setBusy("add");
    setError(null);
    try {
      await addStaff(operator.id, email);
      setEmail("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add them.");
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

  return (
    <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
      <h2 className="font-heading m-0 text-[18px] font-bold">Staff</h2>
      <p className="m-0 mt-1 mb-3.5 text-[12.5px] text-muted">
        Everyone here can run the queue, take payment and change these settings.
      </p>

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
                <span className="block truncate text-[13px] font-semibold">
                  {s.name ?? s.email ?? s.user_id}
                  {s.user_id === me && <span className="ml-1.5 font-normal text-muted">(you)</span>}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted">
                  {s.email && s.name ? `${s.email} · ` : ""}
                  {s.has_pin ? "PIN set" : "no PIN — can't use desk sign-in yet"}
                </span>
              </span>
              <button
                onClick={() => remove(s.user_id)}
                disabled={busy === s.user_id || staff.length <= 1}
                title={staff.length <= 1 ? "The last person can't leave" : "Remove"}
                aria-label={`Remove ${s.name ?? s.email ?? "this person"}`}
                className="grid size-9 shrink-0 place-items-center rounded-lg border border-line text-muted transition-colors hover:text-ink disabled:opacity-40"
              >
                {busy === s.user_id ? <Loader2 size={13} className="animate-spin" /> : <UserMinus size={14} strokeWidth={2.2} />}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        className="mt-3 flex gap-2"
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Their sign-in email"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-xl border border-line bg-surface-sunk px-3 py-2.5 text-[13px] outline-none focus:border-ink"
        />
        <button
          type="submit"
          disabled={busy === "add" || !email.trim()}
          className={cn(
            "flex h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-[13px] font-semibold disabled:opacity-40",
            email.trim() ? "bg-ink text-paper" : "border border-line text-faint",
          )}
        >
          {busy === "add" ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} strokeWidth={2.2} />}
          Add
        </button>
      </form>
      <p className="m-0 mt-2 text-[11px] leading-relaxed text-muted">
        They need to have signed in to Printify once. Whoever they are, they get exactly what you have —
        there is no read-only role yet.
      </p>
      {error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{error}</p>}
    </section>
  );
}
