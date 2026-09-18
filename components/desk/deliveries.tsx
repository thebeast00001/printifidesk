"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { AnimatePresence, motion } from "motion/react";
import { Drawer } from "vaul";
import {
  Banknote,
  Bike,
  Camera,
  Check,
  Loader2,
  LogOut,
  MapPin,
  Package,
  PackageCheck,
  Phone,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { useChanged } from "@/lib/changed";
import { runnerDeliver, runnerOrders, runnerPickup, runnerReturn, type RunnerJob } from "@/lib/delivery";
import { subscribeTable } from "@/lib/realtime";
import { money } from "@/lib/pricing";
import { cn, easeIos, spring } from "@/lib/utils";
import { decodePixels, deskPrefix, nativeDetector, parseCoverScan, parseScan } from "../operator/scan-sheet";
import { useSurface } from "../surface-provider";
import { DeskPushRow } from "./account-panel";
import { InstallNudge } from "./install-nudge";
import { SupportLine } from "../support-line";

/**
 * The runner's page (0046).
 *
 * Three lists, in the order a round goes: what's in your hands, what's
 * waiting on a shelf, and what you've delivered today. Every row is a
 * person's name, the spot they said they'd be (moved, if they moved), a
 * phone to call and what to take in cash; every
 * action is one of the three functions in the database — picked up,
 * delivered, couldn't deliver — which check that this account is a runner
 * and that this job is theirs.
 *
 * The list moves the moment something happens (0049): a runner isn't the
 * owner or the desk of any order, so the orders socket says nothing to
 * them — but every event they should act on writes them a notification
 * row (a delivery filed on a shelf, a student who moved), and the page
 * listens for its own rows. The fifteen-second poll stays as the floor,
 * for a socket that's down and for what other runners do.
 *
 * `standalone` is the whole site for an account that only delivers: its
 * own header, alerts, install and sign-out. On a desk it sits under the
 * desk's header and keeps to the lists.
 */
const POLL_MS = 15_000;

export function Deliveries({ standalone = false }: { standalone?: boolean }) {
  const { user } = useUser();
  const { userId } = useAuth();
  const clerk = useClerk();
  const { surface } = useSurface();
  const [jobs, setJobs] = useState<RunnerJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scan, setScan] = useState<{ mode: "pickup" } | { mode: "deliver"; job: RunnerJob } | null>(null);
  const [returning, setReturning] = useState<RunnerJob | null>(null);
  const version = useChanged("orders");

  const load = useCallback(async () => {
    try {
      setJobs(await runnerOrders());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load deliveries.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  // A round is walked with the phone in a pocket: reload when the page
  // comes back, and on a slow clock while it's in front.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  // The instant path: a notification row written for this account — a job
  // filed on a shelf, a student who moved — is the signal to read the list
  // again. The row lands in the same transaction as the change it reports.
  useEffect(() => {
    if (!userId) return;
    return subscribeTable({
      table: "notifications",
      filter: `user_id=eq.${userId}`,
      onChange: (change) => {
        if (change.eventType === "INSERT") void load();
      },
    });
  }, [userId, load]);

  const act = useCallback(
    async (id: string, work: () => Promise<void>) => {
      setBusy(id);
      setError(null);
      try {
        await work();
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "That didn't go through.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const mine = useMemo(() => (jobs ?? []).filter((j) => j.status === "delivering" && j.mine), [jobs]);
  const waiting = useMemo(() => (jobs ?? []).filter((j) => j.status === "ready"), [jobs]);
  const others = useMemo(() => (jobs ?? []).filter((j) => j.status === "delivering" && !j.mine), [jobs]);
  const done = useMemo(() => (jobs ?? []).filter((j) => j.status === "collected"), [jobs]);
  const cashInHand = mine.reduce((n, j) => n + j.cash_due, 0) + done.reduce((n, j) => n + j.cash_due, 0);

  // Waiting jobs grouped by desk: a round is one desk's shelf, then the hostels.
  const byDesk = useMemo(() => {
    const map = new Map<string, RunnerJob[]>();
    for (const j of waiting) {
      const list = map.get(j.desk) ?? [];
      list.push(j);
      map.set(j.desk, list);
    }
    return [...map.entries()];
  }, [waiting]);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-anim="board">
      {standalone ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-heading m-0 flex items-center gap-2 text-[20px] font-bold">
              <Bike size={18} strokeWidth={2.2} />
              Deliveries
            </h2>
            <p className="m-0 mt-0.5 text-[12.5px] text-muted">
              {user?.firstName ? `${user.firstName}, Printifi runner` : "Printifi runner"}
            </p>
          </div>
          <button
            onClick={() => setScan({ mode: "pickup" })}
            className="flex h-11 items-center gap-2 rounded-xl bg-ink px-3.5 text-[13px] font-semibold text-paper"
          >
            <ScanLine size={14} strokeWidth={2.2} />
            Scan
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="label-caps m-0 flex items-center gap-1.5">
            <Bike size={12} strokeWidth={2.4} />
            Deliveries
          </p>
          <button
            onClick={() => setScan({ mode: "pickup" })}
            className="flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3.5 text-[12.5px] font-semibold"
          >
            <ScanLine size={14} strokeWidth={2.2} />
            Scan a cover sheet
          </button>
        </div>
      )}

      {standalone && <InstallNudge why="Full screen on a round, and a delivery filed on a shelf buzzes the phone in a pocket." />}

      {error && (
        <p className="m-0 rounded-[14px] bg-clay px-4 py-3 text-[12.5px] font-semibold text-clay-ink">{error}</p>
      )}

      {jobs === null ? (
        <Shell>
          <Loader2 size={15} className="animate-spin" />
          Loading deliveries…
        </Shell>
      ) : (
        <>
          {/* In your hands */}
          <Section
            title="With you"
            count={mine.length}
            empty="Nothing in your hands. Pick up from a shelf below."
            hint={cashInHand > 0 ? `${money(cashInHand)} cash to hand in to Printifi` : undefined}
          >
            {mine.map((job) => (
              <JobCard key={job.id} job={job} busy={busy === job.id}>
                {/* The one thing to do at the spot, big: scan the phone they
                    hold up. The two ways round it sit under it, smaller. */}
                <button
                  disabled={busy === job.id}
                  onClick={() => setScan({ mode: "deliver", job })}
                  className="flex h-[52px] w-full items-center justify-center gap-2.5 rounded-2xl bg-ink px-4 text-[15px] font-semibold text-paper disabled:opacity-60"
                >
                  <ScanLine size={18} strokeWidth={2.2} />
                  Scan their QR to hand over
                </button>
                <div className="grid w-full grid-cols-2 gap-2">
                  <button
                    disabled={busy === job.id}
                    onClick={() => void act(job.id, () => runnerDeliver(job.id, null))}
                    title="No scan possible — the row says it was on your word."
                    className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-2 text-[12px] font-semibold text-ink-soft disabled:opacity-60"
                  >
                    <PackageCheck size={13} strokeWidth={2.2} />
                    Handed over, no scan
                  </button>
                  <button
                    disabled={busy === job.id}
                    onClick={() => setReturning(job)}
                    className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-2 text-[12px] font-semibold text-muted disabled:opacity-60"
                  >
                    <Undo2 size={13} strokeWidth={2.2} />
                    Couldn&apos;t deliver
                  </button>
                </div>
              </JobCard>
            ))}
          </Section>

          {/* On the shelves */}
          <Section
            title="Ready to pick up"
            count={waiting.length}
            empty="No deliveries waiting. You'll get a notification when a desk files one."
          >
            {byDesk.map(([desk, list]) => (
              <div key={desk} className="flex flex-col gap-2">
                <p className="m-0 mt-1 text-[11.5px] font-semibold text-muted">
                  {desk}
                  {list[0]?.campus ? ` · ${list[0].campus}` : ""}
                </p>
                {list.map((job) => (
                  <JobCard key={job.id} job={job} busy={busy === job.id}>
                    <button
                      disabled={busy === job.id}
                      onClick={() => void act(job.id, () => runnerPickup(job.id))}
                      className="flex h-[52px] w-full items-center justify-center gap-2.5 rounded-2xl bg-ink px-4 text-[15px] font-semibold text-paper disabled:opacity-60"
                    >
                      <Package size={18} strokeWidth={2.2} />
                      Picked up from the shelf
                    </button>
                  </JobCard>
                ))}
              </div>
            ))}
          </Section>

          {others.length > 0 && (
            <Section title="With another runner" count={others.length} empty="">
              {others.map((job) => (
                <JobCard key={job.id} job={job} busy={false} quiet />
              ))}
            </Section>
          )}

          {done.length > 0 && (
            <Section title="Delivered today" count={done.length} empty="">
              {done.map((job) => (
                <JobCard key={job.id} job={job} busy={false} quiet />
              ))}
            </Section>
          )}
        </>
      )}

      {standalone && (
        <section className="rounded-[20px] border border-line bg-surface p-4 shadow-card lg:p-5">
          <p className="m-0 text-[14px] font-semibold tracking-[-0.01em]">Your runner account</p>
          <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">
            {user?.primaryEmailAddress?.emailAddress ?? ""}
          </p>
          <DeskPushRow what="deliveries" />
          <button
            onClick={() => void clerk.signOut({ redirectUrl: surface === "desk" ? "/sign-in" : "/operator" })}
            className="mt-4 flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-surface-sunk"
          >
            <LogOut size={14} strokeWidth={2.2} />
            Sign out
          </button>
        </section>
      )}

      {standalone && <SupportLine desk deskName="Printifi deliveries" />}

      <RunnerScanner
        open={scan !== null}
        onOpenChange={(o) => !o && setScan(null)}
        mode={scan?.mode ?? "pickup"}
        job={scan?.mode === "deliver" ? scan.job : null}
        waiting={waiting}
        onPickup={(job) => {
          setScan(null);
          void act(job.id, () => runnerPickup(job.id));
        }}
        onDeliver={(job, code) => {
          setScan(null);
          void act(job.id, () => runnerDeliver(job.id, code));
        }}
      />

      <ReturnSheet
        job={returning}
        onClose={() => setReturning(null)}
        onReturn={(job, reason) => {
          setReturning(null);
          void act(job.id, () => runnerReturn(job.id, reason));
        }}
      />
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  hint,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="label-caps m-0">
          {title}
          {count > 0 && <span className="ml-1.5 font-mono text-faint">{count}</span>}
        </p>
        {hint && <p className="m-0 text-[11.5px] text-muted">{hint}</p>}
      </div>
      {count === 0 ? (
        empty ? <p className="m-0 rounded-[16px] border border-dashed border-line px-4 py-3 text-[12.5px] text-muted">{empty}</p> : null
      ) : (
        children
      )}
    </section>
  );
}

/** One job: the token big, the person, the spot, the phone, the cash. */
function JobCard({ job, busy, quiet, children }: { job: RunnerJob; busy: boolean; quiet?: boolean; children?: React.ReactNode }) {
  const where = [job.spot, job.detail].filter(Boolean).join(" · ");
  const firstName = (job.student ?? "").trim().split(/\s+/)[0] || "Student";
  // The student moved after this left the shelf: the spot on the card is
  // newer than the pickup, and says so.
  const moved =
    job.status === "delivering" && job.spot_changed_at && job.picked_up_at && new Date(job.spot_changed_at) > new Date(job.picked_up_at);
  return (
    <article className={cn("rounded-[20px] border border-line bg-surface p-4 shadow-card", quiet && "opacity-80")}>
      <div className="flex items-start gap-3.5">
        <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-surface-sunk font-mono text-base font-medium tracking-wide">
          {job.token ?? "—"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{job.student ?? firstName}</p>
          <p className={cn("m-0 mt-0.5 flex items-center gap-1.5 text-[12.5px]", moved ? "font-semibold text-ink" : "text-ink-soft")}>
            <MapPin size={12} strokeWidth={2.2} className="shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{where || "No spot given — call them"}</span>
            {moved && (
              <span className="shrink-0 rounded-full bg-clay px-2 py-0.5 text-[10px] font-semibold text-clay-ink">
                moved {new Date(job.spot_changed_at!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </p>
          <p className="m-0 mt-0.5 text-[12px] text-muted">
            {job.pages} {job.pages === 1 ? "page" : "pages"} · {job.desk}
            {job.shelf_slot && job.status === "ready" ? ` · shelf ${job.shelf_slot}` : ""}
            {job.delivery_returns > 0 && job.status !== "collected" ? ` · brought back ${job.delivery_returns === 1 ? "once" : `${job.delivery_returns} times`}` : ""}
          </p>
        </div>
        {job.phone && job.status !== "collected" && (
          <a
            href={`tel:${job.phone}`}
            className="grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-surface text-ink"
            aria-label={`Call ${firstName}`}
          >
            <Phone size={16} strokeWidth={2.2} />
          </a>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {job.cash_due > 0 ? (
          <span className="flex items-center gap-1 rounded-full bg-bone px-2.5 py-1 text-[11px] font-semibold text-ink">
            <Banknote size={11} strokeWidth={2.4} />
            {job.status === "collected" ? `took ${money(job.cash_due)} cash` : `take ${money(job.cash_due)} in cash`}
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-full bg-sage px-2.5 py-1 text-[11px] font-semibold text-sage-ink">
            <ShieldCheck size={11} strokeWidth={2.4} />
            paid — nothing to take
          </span>
        )}
        {job.status === "collected" && (
          <span className="rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-muted">
            {job.delivery_proof === "scan" ? "code scanned" : "on your word"}
            {job.delivered_at ? ` · ${new Date(job.delivered_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
          </span>
        )}
        {job.status === "delivering" && job.picked_up_at && (
          <span className="rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-muted">
            {job.mine ? "picked up" : "with another runner"} · {new Date(job.picked_up_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>

      {children && (
        <div className="mt-3 flex flex-col gap-2">
          {busy ? (
            <span className="flex h-[52px] items-center justify-center rounded-2xl bg-surface-sunk">
              <Loader2 size={18} className="animate-spin text-muted" />
            </span>
          ) : (
            children
          )}
        </div>
      )}
    </article>
  );
}

/** Why it's going back, in the student's words-to-be. */
function ReturnSheet({
  job,
  onClose,
  onReturn,
}: {
  job: RunnerJob | null;
  onClose: () => void;
  onReturn: (job: RunnerJob, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (job) setReason("");
  }, [job]);
  const quick = ["Nobody at the spot", "Didn't pick up the phone", "Wrong spot given", "Couldn't pay the cash"];
  return (
    <Drawer.Root open={job !== null} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.45)] backdrop-blur-[3px]" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-80 mx-auto flex max-h-[92dvh] w-full max-w-[520px] flex-col rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]">
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />
          <div className="px-[18px] pt-3.5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <Drawer.Title className="font-figure m-0 mb-1 text-[23px] font-extrabold">Couldn&apos;t deliver {job?.token ?? ""}</Drawer.Title>
            <Drawer.Description className="m-0 mb-4 text-[13px] text-muted">
              It goes back on the desk&apos;s shelf as ready. The student is told why, and that they can
              collect it there or wait for the next round.
            </Drawer.Description>
            <div className="mb-3 flex flex-wrap gap-2">
              {quick.map((q) => (
                <button
                  key={q}
                  onClick={() => setReason(q)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-[12px] font-semibold",
                    reason === q ? "border-ink bg-ink text-paper" : "border-line bg-surface text-ink-soft",
                  )}
                >
                  {q}
                </button>
              ))}
            </div>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={140}
              placeholder="Or say why in your own words"
              aria-label="Reason"
              className="h-11 w-full rounded-xl border border-line bg-surface-sunk px-3.5 text-[14px] outline-none placeholder:text-faint focus:border-ink"
            />
            <button
              disabled={reason.trim().length < 2 || !job}
              onClick={() => job && onReturn(job, reason)}
              className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-ink text-[15px] font-semibold text-paper disabled:opacity-40"
            >
              <RotateCcw size={15} strokeWidth={2.2} />
              Back to the desk
            </button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/**
 * The runner's camera. At a shelf it reads the cover sheet's code
 * (`printify:cover:<token>:<desk>`) and picks that job up; at the spot it
 * reads the student's code (`printify:order:<token>:<secret>:<desk>`) and
 * hands the job over with the secret — which the database checks, so a
 * wrong phone is refused, not recorded. Same decoders as the desk's scanner.
 */
function RunnerScanner({
  open,
  onOpenChange,
  mode,
  job,
  waiting,
  onPickup,
  onDeliver,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "pickup" | "deliver";
  job: RunnerJob | null;
  waiting: RunnerJob[];
  onPickup: (job: RunnerJob) => void;
  onDeliver: (job: RunnerJob, code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [supported] = useState(() => typeof window !== "undefined" && window.isSecureContext);
  const [camera, setCamera] = useState<"idle" | "starting" | "on" | "denied">("idle");
  const [miss, setMiss] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera("idle");
  }, []);

  const resolve = useCallback(
    (raw: string): boolean => {
      if (mode === "deliver" && job) {
        const parsed = parseScan(raw);
        if (!parsed) {
          setMiss("That isn't a Printifi code.");
          return false;
        }
        if (parsed.token !== (job.token ?? "").toUpperCase()) {
          setMiss(`That code is for ${parsed.token}, not ${job.token}. Check you have the right person.`);
          return false;
        }
        if (!parsed.code) {
          setMiss("That's a slip or a cover, not the student's phone — their QR carries the code.");
          return false;
        }
        onDeliver(job, parsed.code);
        return true;
      }
      // At a shelf: a cover sheet, or a typed token, names one waiting job.
      const cover = parseCoverScan(raw);
      const token = cover?.token ?? parseScan(raw)?.token ?? null;
      if (!token) {
        setMiss("That isn't a Printifi code.");
        return false;
      }
      const found = waiting.filter(
        (j) => (j.token ?? "").toUpperCase() === token && (!cover || deskPrefix(j.operator_id) === cover.desk),
      );
      if (found.length === 1) {
        onPickup(found[0]);
        return true;
      }
      setMiss(found.length > 1 ? `Two ${token}s are waiting — pick it from the list.` : `${token} isn't a delivery waiting on a shelf.`);
      return false;
    },
    [mode, job, waiting, onPickup, onDeliver],
  );
  // The list behind `resolve` is refreshed every fifteen seconds; the
  // camera mustn't restart each time. The loop reads the latest through a ref.
  const resolveRef = useRef(resolve);
  // oxlint-disable-next-line react/refs -- the latest-value ref, read by the frame loop that outlives this render
  resolveRef.current = resolve;

  useEffect(() => {
    if (!open || !supported) {
      stop();
      return;
    }
    let cancelled = false;
    let raf = 0;
    (async () => {
      setCamera("starting");
      const detector = await nativeDetector();
      if (cancelled) return;
      const scratch = (scratchRef.current ??= document.createElement("canvas"));
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setCamera("on");
        const every = detector ? 120 : 180;
        let last = 0;
        const tick = async (t: number) => {
          if (cancelled) return;
          if (t - last > every && video.readyState >= 2) {
            last = t;
            try {
              let raw: string | null = null;
              if (detector) {
                const codes = await detector.detect(video);
                raw = codes.find((c) => parseScan(c.rawValue) || parseCoverScan(c.rawValue))?.rawValue ?? null;
              } else {
                const text = decodePixels(video, scratch);
                raw = text && (parseScan(text) || parseCoverScan(text)) ? text : null;
              }
              if (raw && resolveRef.current(raw)) return;
            } catch {
              /* a frame that couldn't be read; the next one will */
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) setCamera("denied");
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stop();
    };
  }, [open, supported, stop]);

  useEffect(() => {
    if (!open) {
      setMiss(null);
      setTyped("");
    }
  }, [open]);

  async function readPhoto(file: File) {
    setMiss(null);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((ok, fail) => {
        img.onload = () => ok();
        img.onerror = () => fail(new Error("unreadable"));
        img.src = url;
      });
      const scratch = (scratchRef.current ??= document.createElement("canvas"));
      const text = decodePixels(img, scratch);
      if (!text || !resolve(text)) setMiss((m) => m ?? "No Printifi code in that photo.");
    } catch {
      setMiss("Couldn't read that photo.");
    } finally {
      URL.revokeObjectURL(url);
      if (photoRef.current) photoRef.current.value = "";
    }
  }

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.45)] backdrop-blur-[3px]" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-80 mx-auto flex max-h-[92dvh] w-full max-w-[520px] flex-col rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]">
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <Drawer.Title className="font-figure m-0 mb-1 text-[23px] font-extrabold">
              {mode === "deliver" ? `Hand over ${job?.token ?? ""}` : "Pick up from the shelf"}
            </Drawer.Title>
            <Drawer.Description className="m-0 mb-4 text-[13px] text-muted">
              {mode === "deliver"
                ? `Scan the QR on ${job?.student?.split(/\s+/)[0] ?? "the student"}'s phone. The code in it is what proves it's them.`
                : "Point at the cover sheet's QR on the pile, or type the token."}
            </Drawer.Description>

            <div className="relative aspect-[4/3] overflow-hidden rounded-[18px] bg-ink">
              <video ref={videoRef} playsInline muted className={cn("size-full object-cover", camera !== "on" && "opacity-0")} />
              {camera !== "on" && (
                <div className="absolute inset-0 grid place-items-center px-6 text-center text-[12.5px] text-paper/80">
                  {!supported
                    ? "The live camera needs a secure (https) address — use a photo below."
                    : camera === "denied"
                      ? "Camera blocked. Allow it for this site, or use a photo below."
                      : (
                        <span className="flex items-center gap-2">
                          <Loader2 size={14} className="animate-spin" />
                          Starting the camera…
                        </span>
                      )}
                </div>
              )}
              {camera === "on" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, ease: easeIos }}
                  className="pointer-events-none absolute inset-[18%] rounded-[16px] border-2 border-paper/70"
                />
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <label className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 text-[12.5px] font-semibold">
                <Camera size={14} strokeWidth={2.2} />
                Take a photo instead
                <input
                  ref={photoRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void readPhoto(f);
                  }}
                />
              </label>
            </div>

            {mode === "pickup" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (typed.trim()) resolve(typed);
                }}
                className="mt-3 flex gap-2"
              >
                <input
                  value={typed}
                  onChange={(e) => {
                    setMiss(null);
                    setTyped(e.target.value.toUpperCase());
                  }}
                  placeholder="Or type the token, e.g. C14"
                  aria-label="Token"
                  autoCapitalize="characters"
                  className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface-sunk px-3.5 font-mono text-[15px] uppercase outline-none placeholder:font-sans placeholder:normal-case placeholder:text-faint focus:border-ink"
                />
                <button type="submit" className="flex h-11 items-center gap-1.5 rounded-xl bg-ink px-4 text-[13px] font-semibold text-paper">
                  <Check size={14} strokeWidth={2.6} />
                  Find
                </button>
              </form>
            )}

            <AnimatePresence initial={false}>
              {miss && (
                <motion.p
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={spring}
                  className="m-0 mt-3 flex items-start gap-2 rounded-xl bg-clay px-3 py-2.5 text-[12px] leading-snug text-clay-ink"
                >
                  <X size={13} strokeWidth={2.4} className="mt-px shrink-0" />
                  {miss}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[20px] border border-line bg-surface p-4 text-[13px] text-muted lg:p-5">
      {children}
    </div>
  );
}
