"use client";

import { useCallback, useEffect, useState } from "react";
import { Bike, Check, Loader2, Store, UserPlus, UserRoundX } from "lucide-react";
import {
  addRunner,
  adminDeliveryReport,
  adminRunners,
  setDeliveryPolicy,
  setDeskDelivery,
  setRunner,
  type DeliveryPolicy,
  type DeliveryReport,
  type RunnerRow,
} from "@/lib/delivery";
import { listOperators, type Operator } from "@/lib/orders";
import { platformSettings } from "@/lib/platform";
import { money } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * Delivery to the door (0046), all of it the admin's: the switch and the
 * fee, the hostels served, which desks the runner collects from, and who
 * the runners are — requests to approve, runners to remove, an email to
 * grant by hand (yourself, to start with). Removing a runner puts whatever
 * they were carrying back on the desk's shelf, so nothing is stranded.
 */
export function AdminRunners() {
  const [policy, setPolicy] = useState<DeliveryPolicy | null>(null);
  const [draft, setDraft] = useState<DeliveryPolicy | null>(null);
  const [areasText, setAreasText] = useState("");
  const [roundsText, setRoundsText] = useState("");
  const [report, setReport] = useState<DeliveryReport | null>(null);
  const [runners, setRunners] = useState<RunnerRow[] | null>(null);
  const [desks, setDesks] = useState<Operator[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, r, list, ops] = await Promise.all([platformSettings(true), adminDeliveryReport(), adminRunners(), listOperators()]);
      const p = { enabled: s.delivery_enabled, fee: s.delivery_fee, areas: s.delivery_areas, note: s.delivery_note ?? "", rounds: s.delivery_rounds };
      setPolicy(p);
      setDraft((d) => d ?? p);
      setAreasText((t) => t || p.areas.join(", "));
      setRoundsText((t) => t || p.rounds.join(", "));
      setReport(r);
      setRunners(list);
      setDesks(ops);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePolicy() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = {
        ...draft,
        areas: areasText.split(/[,\n]/).map((a) => a.trim()).filter(Boolean),
        rounds: roundsText.split(/[,\n]/).map((r) => r.trim()).filter(Boolean),
      };
      await setDeliveryPolicy(next);
      // Read back what the database kept — rounds come back tidied and sorted.
      const s = await platformSettings(true);
      const kept = { ...next, areas: s.delivery_areas, rounds: s.delivery_rounds };
      setPolicy(kept);
      setDraft(kept);
      setAreasText(kept.areas.join(", "));
      setRoundsText(kept.rounds.join(", "));
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  async function run(key: string, work: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through.");
    } finally {
      setBusy(null);
    }
  }

  const dirty =
    policy && draft &&
    JSON.stringify({ ...policy, areas: policy.areas.join(", "), rounds: policy.rounds.join(", ") }) !==
      JSON.stringify({ ...draft, areas: areasText, rounds: roundsText });
  const requests = (runners ?? []).filter((r) => r.status === "requested");
  const active = (runners ?? []).filter((r) => r.status === "active");
  const removed = (runners ?? []).filter((r) => r.status === "removed");

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
        <h2 className="font-heading m-0 flex items-center gap-2 text-[18px] font-bold">
          <Bike size={17} strokeWidth={2.2} />
          Delivery to the door
        </h2>
        <p className="m-0 mt-0.5 text-[12.5px] leading-relaxed text-muted">
          A student can have the job brought to a spot on campus by Printifi&apos;s runner instead of walking to the
          desk. They pick the spot from your list for the round it&apos;ll come on, and can move it any time until
          it&apos;s handed over — the runner is told. The desk prints and files it as always; the runner picks it up
          and hands it over against the student&apos;s code. The fee is Printifi&apos;s; the desk is paid its price
          whatever way the student paid.
        </p>

        {report && (
          <dl className="m-0 mt-3.5 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-4">
            <Stat label="Delivered" value={String(report.delivered)} sub={`${report.returned} brought back to a desk`} strong />
            <Stat label="Right now" value={`${report.in_flight} out · ${report.waiting} waiting`} sub={`${report.active_runners} active ${report.active_runners === 1 ? "runner" : "runners"}`} />
            <Stat label="Fees earned" value={money(report.fees_earned)} sub={report.fees_owed_by_desks > 0 ? `${money(report.fees_owed_by_desks)} of it held by desks, owed on` : "on delivered orders"} />
            <Stat label="Cash taken on handover" value={money(report.cash_in_hand)} sub="held by runners; the desks' price on it is credited" />
          </dl>
        )}

        {draft && (
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                className="size-4 accent-ink"
              />
              <span className="text-[13px] font-semibold">Offer delivery to students</span>
              <span className="text-[11.5px] text-muted">— only at desks switched on below, only to the spots listed</span>
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] font-semibold text-ink-soft">Delivery fee</span>
                <span className="flex items-center gap-1 rounded-xl border border-line bg-surface-sunk px-2.5 py-2 font-mono text-[13px] focus-within:border-ink">
                  <span className="text-muted">₹</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={200}
                    value={Number.isFinite(draft.fee) ? draft.fee : ""}
                    onChange={(e) => setDraft({ ...draft, fee: Number(e.target.value) })}
                    className="w-full min-w-0 bg-transparent outline-none"
                  />
                </span>
                <span className="text-[11px] text-muted">per order, after the desk&apos;s bill; Printifi&apos;s</span>
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-[11.5px] font-semibold text-ink-soft">Spots on campus</span>
                <input
                  value={areasText}
                  onChange={(e) => setAreasText(e.target.value)}
                  placeholder="Ganga hostel, Kaveri hostel, Library entrance, Block A gate, Canteen"
                  className="h-[38px] w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[13px] outline-none placeholder:text-faint focus:border-ink"
                />
                <span className="text-[11px] text-muted">
                  comma-separated; the student picks one and adds a detail (a room number, &ldquo;near the steps&rdquo;). Empty
                  means they type any spot.
                </span>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] font-semibold text-ink-soft">Rounds leave at</span>
                <input
                  value={roundsText}
                  onChange={(e) => setRoundsText(e.target.value)}
                  placeholder="13:00, 18:00"
                  className="h-[38px] w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 font-mono text-[13px] outline-none placeholder:text-faint focus:border-ink"
                />
                <span className="text-[11px] text-muted">
                  24-hour, IST. The student is asked &ldquo;the 1:00 pm round — where will you be?&rdquo;; empty says
                  &ldquo;the next round&rdquo;.
                </span>
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-[11.5px] font-semibold text-ink-soft">A line the student reads</span>
                <input
                  value={draft.note}
                  maxLength={200}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                  placeholder="e.g. Order at least 20 minutes before a round to catch it"
                  className="h-[38px] w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[13px] outline-none placeholder:text-faint focus:border-ink"
                />
              </label>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={() => void savePolicy()}
            disabled={!dirty || saving}
            className="flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} strokeWidth={2.6} /> : null}
            {saved ? "Saved" : "Save"}
          </button>
          {error && <span className="text-[12px] text-clay-ink dark:text-clay">{error}</span>}
        </div>
      </section>

      <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
        <h2 className="font-heading m-0 flex items-center gap-2 text-[18px] font-bold">
          <Store size={17} strokeWidth={2.2} />
          Desks the runner collects from
        </h2>
        <p className="m-0 mt-0.5 text-[12.5px] leading-relaxed text-muted">
          A desk the runner never visits mustn&apos;t offer delivery. This is yours to switch, like online payment; the
          desk&apos;s owner can&apos;t.
        </p>
        <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
          {desks.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line bg-surface-sunk px-3.5 py-2.5">
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold">{d.short_name || d.name}</span>
                <span className="block text-[11.5px] text-muted">{d.campus}</span>
              </span>
              <button
                disabled={busy === d.id}
                onClick={() => void run(d.id, () => setDeskDelivery(d.id, !d.delivery))}
                className={cn(
                  "flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold disabled:opacity-60",
                  d.delivery ? "bg-sage text-sage-ink" : "border border-line bg-surface text-muted",
                )}
              >
                {busy === d.id ? <Loader2 size={12} className="animate-spin" /> : d.delivery ? <Check size={12} strokeWidth={2.6} /> : null}
                {d.delivery ? "Delivers" : "Off"}
              </button>
            </li>
          ))}
          {desks.length === 0 && <li className="text-[12.5px] text-muted">No listed desks yet.</li>}
        </ul>
      </section>

      <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
        <h2 className="font-heading m-0 flex items-center gap-2 text-[18px] font-bold">
          <UserPlus size={17} strokeWidth={2.2} />
          Runners
        </h2>
        <p className="m-0 mt-0.5 text-[12.5px] leading-relaxed text-muted">
          A runner sees students&apos; names, phones and rooms for the jobs on the shelves, and marks orders delivered
          and cash taken — so nobody becomes one by asking. Approve a request, or grant an account by its email
          (yours, to start with). Removing a runner puts what they carried back on the desk&apos;s shelf.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void run("add", async () => { await addRunner(email); setEmail(""); });
          }}
          className="mt-3 flex flex-wrap gap-2"
        >
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="Grant by email — an account that has signed in to the desk site"
            aria-label="Email"
            className="h-10 min-w-[240px] flex-1 rounded-xl border border-line bg-surface-sunk px-3 text-[13px] outline-none placeholder:text-faint focus:border-ink"
          />
          <button
            type="submit"
            disabled={busy === "add" || !email.trim()}
            className="flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
          >
            {busy === "add" ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} strokeWidth={2.2} />}
            Grant
          </button>
        </form>

        {runners === null ? (
          <p className="m-0 mt-3 flex items-center gap-2 text-[12.5px] text-muted">
            <Loader2 size={13} className="animate-spin" />
            Loading…
          </p>
        ) : (
          <>
            <RunnerList title="Requests" rows={requests} empty="No requests waiting." busy={busy} action="approve" secondary="ignore" run={run} />
            <RunnerList title="Active" rows={active} empty="No runners yet — grant yourself above to start delivering." busy={busy} action="remove" run={run} />
            {removed.length > 0 && <RunnerList title="Removed" rows={removed} empty="" busy={busy} action="regrant" run={run} />}
          </>
        )}
      </section>
    </div>
  );
}

/** What the one button on a row does: approve or re-grant (active), remove or ignore (removed). */
type RunnerAction = "approve" | "remove" | "regrant" | "ignore";
const ACTION_LABEL: Record<RunnerAction, string> = { approve: "Approve", remove: "Remove", regrant: "Grant again", ignore: "Ignore" };
const activates = (a: RunnerAction) => a === "approve" || a === "regrant";

function RunnerList({
  title,
  rows,
  empty,
  busy,
  action,
  secondary,
  run,
}: {
  title: string;
  rows: RunnerRow[];
  empty: string;
  busy: string | null;
  action: RunnerAction;
  secondary?: RunnerAction;
  run: (key: string, work: () => Promise<void>) => Promise<void>;
}) {
  return (
    <div className="mt-4">
      <p className="label-caps m-0 mb-2">
        {title}
        {rows.length > 0 && <span className="ml-1.5 font-mono text-faint">{rows.length}</span>}
      </p>
      {rows.length === 0 ? (
        empty ? <p className="m-0 text-[12.5px] text-muted">{empty}</p> : null
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <li key={r.user_id} className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line bg-surface-sunk px-3.5 py-2.5">
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold">{r.name ?? r.email ?? r.user_id}</span>
                <span className="block text-[11.5px] text-muted">
                  {[r.email, r.phone].filter(Boolean).join(" · ") || "no email or phone on the profile"}
                  {r.status === "active" ? ` · ${r.delivered} delivered${r.carrying ? ` · ${r.carrying} in hand` : ""}` : ""}
                  {r.status === "requested" ? ` · asked ${new Date(r.requested_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {secondary && (
                  <button
                    disabled={busy === r.user_id}
                    onClick={() => void run(r.user_id, () => setRunner(r.user_id, activates(secondary)))}
                    className="h-9 rounded-full border border-line bg-surface px-3.5 text-[12px] font-semibold text-muted disabled:opacity-60"
                  >
                    {ACTION_LABEL[secondary]}
                  </button>
                )}
                <button
                  disabled={busy === r.user_id}
                  onClick={() => void run(r.user_id, () => setRunner(r.user_id, activates(action)))}
                  className={cn(
                    "flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold disabled:opacity-60",
                    action === "approve" ? "bg-ink text-paper" : "border border-line bg-surface text-ink-soft",
                  )}
                >
                  {busy === r.user_id ? <Loader2 size={12} className="animate-spin" /> : action === "remove" ? <UserRoundX size={12} strokeWidth={2.4} /> : null}
                  {ACTION_LABEL[action]}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className="min-w-0 rounded-[14px] border border-line bg-surface-sunk px-3.5 py-3">
      <dt className="m-0 text-[10.5px] font-semibold tracking-[0.06em] text-muted uppercase">{label}</dt>
      <dd className={`m-0 mt-0.5 font-mono tabular-nums ${strong ? "text-[20px] font-semibold" : "text-[16px]"}`}>{value}</dd>
      {sub && <dd className="m-0 mt-0.5 text-[11.5px] text-muted">{sub}</dd>}
    </div>
  );
}
