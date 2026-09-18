"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bike, Check, Clock, Loader2, ShieldAlert } from "lucide-react";
import { requestRunner, type RunnerStatus } from "@/lib/delivery";
import { isAdmin } from "@/lib/operator";
import { cn } from "@/lib/utils";

/**
 * The other way onto the desk site (0046): delivering for Printifi.
 *
 * A request, not a role — tapping it sends the admin a note with this
 * account's name and phone, and opens nothing. Deliveries appears only
 * once the admin has approved it in /admin, because a runner sees
 * students' names, phones and room numbers, and marks orders delivered and
 * cash taken: that is access, not a preference.
 */
export function RunnerRequest({ status, onChanged }: { status: RunnerStatus; onChanged: () => void }) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The admin doesn't ask; they grant — themselves included.
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    void isAdmin().then(setAdmin);
  }, []);

  async function ask() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestRunner(phone);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[20px] border border-line bg-surface p-5 shadow-card lg:p-6">
      <p className="label-caps m-0 flex items-center gap-1.5">
        <Bike size={12} strokeWidth={2.4} />
        Deliver for Printifi
      </p>

      {admin ? (
        <>
          <h2 className="font-heading m-0 mt-1 text-[22px] font-bold">Runners are yours to grant</h2>
          <p className="m-0 mt-1 max-w-[52ch] text-[12.5px] leading-relaxed text-muted">
            You&apos;re the admin. Under{" "}
            <Link href="/admin/runners" className="font-semibold text-ink underline-offset-2 hover:underline">
              Runners
            </Link>{" "}
            switch delivery on, pick the desks the runner collects from, and grant an account by its email —
            this one, to start delivering yourself.
          </p>
        </>
      ) : status === "requested" ? (
        <>
          <h2 className="font-heading m-0 mt-1 text-[22px] font-bold">Request sent</h2>
          <p className="m-0 mt-1 flex items-start gap-2 text-[12.5px] leading-relaxed text-muted">
            <Clock size={14} strokeWidth={2.2} className="mt-0.5 shrink-0" />
            Printifi approves runners by hand. You&apos;ll get a notification when it&apos;s done, and
            Deliveries will be here when you next open the app. Nothing opens until then.
          </p>
        </>
      ) : (
        <>
          <h2 className="font-heading m-0 mt-1 text-[22px] font-bold">
            {status === "removed" ? "Your runner access was removed" : "Carry orders to students' doors"}
          </h2>
          <p className="m-0 mt-1 max-w-[52ch] text-[12.5px] leading-relaxed text-muted">
            {status === "removed" ? (
              <>
                <ShieldAlert size={13} strokeWidth={2.2} className="mr-1 inline-block align-[-2px]" />
                Printifi took this account off the runners. If that was a mistake, ask again below — the
                admin decides.
              </>
            ) : (
              <>
                A runner picks printed jobs up from a desk&apos;s shelf, brings them to the hostel, and hands
                them over at the door against the student&apos;s code — taking the cash where the order was
                cash. Ask below; Printifi approves each runner by hand.
              </>
            )}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
            className="mt-4 flex flex-wrap gap-2"
          >
            <input
              value={phone}
              onChange={(e) => {
                setError(null);
                setPhone(e.target.value);
              }}
              inputMode="tel"
              autoComplete="tel"
              placeholder="Your phone number"
              aria-label="Phone number"
              className="h-11 min-w-[200px] flex-1 rounded-xl border border-line bg-surface-sunk px-3.5 text-[14px] outline-none placeholder:text-faint focus:border-ink"
            />
            <button
              type="submit"
              disabled={busy}
              className={cn(
                "flex h-11 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-60",
              )}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} strokeWidth={2.6} />}
              {status === "removed" ? "Ask again" : "Ask to be a runner"}
            </button>
          </form>
          {error && <p className="m-0 mt-2.5 text-[12.5px] font-semibold text-clay-ink dark:text-clay">{error}</p>}
          <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">
            The phone number is for the admin to reach you; students never see it. What a runner sees of a
            student is their first name, phone, hostel and room — only for the jobs on the shelf, only while
            they&apos;re live.
          </p>
        </>
      )}
    </section>
  );
}
