"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import { Camera, Check, Keyboard, Loader2, ScanLine, ShieldAlert, ShieldCheck } from "lucide-react";
import { orderCustomer, type Customer } from "@/lib/operator";
import type { OrderRow } from "@/lib/orders";
import { cn, spring } from "@/lib/utils";

/**
 * The student holds up their code; the desk points a phone at it.
 *
 * Uses the browser's own `BarcodeDetector` — no library, nothing to load,
 * nothing that could be swapped for something else on a CDN. Chrome and
 * Android have it; Safari and Firefox mostly don't, and there the sheet is a
 * token field with the same result. The one thing it decides is *which* order
 * is in front of you; handing it over is still a tap, because a scan of the
 * wrong student's phone must not be a completed handover.
 */

/**
 * What a scan or a typed token says.
 *
 * The student's code is `printify:order:A03:7F3A9C21` — token and secret.
 * The slip's is `printify:order:A03` — token only, because whoever holds
 * the slip already holds the paper, and it exists to *find*, not to prove.
 * A typed token is the same as a slip.
 */
export function parseScan(raw: string): { token: string; code: string | null } | null {
  const text = raw.trim();
  const m = /^printify:order:([A-Z0-9-]+)(?::([A-Z0-9]{6,16}))?$/i.exec(text);
  const token = (m ? m[1] : text).toUpperCase();
  if (!/^[A-Z]{1,2}\d{1,4}$/.test(token)) return null;
  return { token, code: m?.[2] ? m[2].toUpperCase() : null };
}

/** Kept for callers that only want the token. */
export function tokenFromScan(raw: string): string | null {
  return parseScan(raw)?.token ?? null;
}

type Proof = "verified" | "unverified" | "wrong";

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

function detectorFor(): Detector | null {
  const ctor = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector })
    .BarcodeDetector;
  if (!ctor) return null;
  try {
    return new ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

export function ScanSheet({
  open,
  onOpenChange,
  ready,
  busy,
  onHandOver,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Orders currently waiting to be collected. */
  ready: OrderRow[];
  busy: boolean;
  onHandOver: (order: OrderRow) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [supported] = useState(() => typeof window !== "undefined" && Boolean(detectorFor()));
  const [camera, setCamera] = useState<"idle" | "starting" | "on" | "denied">("idle");
  const [typed, setTyped] = useState("");
  const [match, setMatch] = useState<{ order: OrderRow; proof: Proof } | null>(null);
  /** Two ready orders with the same token — yesterday's and today's. */
  const [choices, setChoices] = useState<OrderRow[]>([]);
  const [miss, setMiss] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera("idle");
  }, []);

  const resolve = useCallback(
    (raw: string) => {
      const parsed = parseScan(raw);
      if (!parsed) {
        setMiss("That doesn't look like a Printify token.");
        return;
      }
      const { token, code } = parsed;
      const candidates = ready.filter((o) => o.token?.toUpperCase() === token);
      if (candidates.length === 0) {
        setMiss(`${token} isn't waiting to be collected here.`);
        setMatch(null);
        setChoices([]);
        return;
      }
      setMiss(null);

      if (code) {
        // The secret picks the order out, and proves the phone is the owner's.
        const owner = candidates.find((o) => o.handover_code?.toUpperCase() === code);
        if (owner) {
          setMatch({ order: owner, proof: "verified" });
          setChoices([]);
          return;
        }
        // A code that matches no order with this token is a forged or stale
        // QR. Say so; don't offer a handover.
        setMatch({ order: candidates[0], proof: "wrong" });
        setChoices([]);
        return;
      }

      // No code: a slip, or a typed token. That finds but doesn't prove.
      if (candidates.length > 1) {
        setChoices(candidates);
        setMatch(null);
        return;
      }
      setMatch({ order: candidates[0], proof: "unverified" });
      setChoices([]);
    },
    [ready],
  );

  // Camera loop. Runs only while the sheet is open and no order has been
  // matched — once one is, the picture is noise and the tap is what matters.
  useEffect(() => {
    if (!open || !supported || match) {
      stop();
      return;
    }

    let cancelled = false;
    let raf = 0;
    const detector = detectorFor();
    if (!detector) return;

    (async () => {
      setCamera("starting");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
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

        // Poll at the display rate; `detect` is quick and a missed frame is
        // just the next one.
        let last = 0;
        const tick = async (t: number) => {
          if (cancelled) return;
          if (t - last > 120 && video.readyState >= 2) {
            last = t;
            try {
              const codes = await detector.detect(video);
              const hit = codes.find((c) => tokenFromScan(c.rawValue));
              if (hit) {
                resolve(hit.rawValue);
                return;
              }
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
  }, [open, supported, match, resolve, stop]);

  useEffect(() => {
    if (!open) {
      setMatch(null);
      setChoices([]);
      setMiss(null);
      setTyped("");
    }
  }, [open]);

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.45)] backdrop-blur-[3px]" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-80 mx-auto flex max-h-[92dvh] w-full max-w-[520px] flex-col
                     rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]"
        >
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <Drawer.Title className="font-figure m-0 mb-1 text-[23px] font-extrabold">
              Hand over
            </Drawer.Title>
            <Drawer.Description className="m-0 mb-4 text-[13px] text-muted">
              {supported
                ? "Point the camera at the student's code, or type the token."
                : "Type the token the student shows you."}
            </Drawer.Description>

            {match ? (
              <MatchPanel
                order={match.order}
                proof={match.proof}
                busy={busy}
                onHandOver={() => onHandOver(match.order)}
                onDismiss={() => setMatch(null)}
              />
            ) : choices.length > 0 ? (
              <div className="rounded-[20px] border border-line bg-surface p-4">
                <p className="m-0 text-[13px] font-semibold">
                  Two orders on the shelf are {choices[0].token} — which one?
                </p>
                <p className="m-0 mt-1 text-[12px] text-muted">
                  Tokens start again each day. Ask them when they ordered, or scan their phone
                  instead — its code says which.
                </p>
                <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
                  {choices.map((o) => (
                    <li key={o.id}>
                      <button
                        onClick={() => {
                          setChoices([]);
                          setMatch({ order: o, proof: "unverified" });
                        }}
                        className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface-sunk px-3 py-2.5 text-left text-[12.5px] transition-colors hover:border-ink"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {o.order_items?.[0]?.name ?? `${o.pages} pages`}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-muted">
                          placed{" "}
                          {new Date(o.created_at).toLocaleString([], {
                            weekday: "short",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                {supported && camera !== "denied" && (
                  <div className="relative aspect-[4/3] overflow-hidden rounded-[20px] bg-black">
                    <video
                      ref={videoRef}
                      playsInline
                      muted
                      className="size-full object-cover"
                    />
                    {camera !== "on" && (
                      <div className="absolute inset-0 grid place-items-center text-[13px] text-white/80">
                        <span className="flex items-center gap-2">
                          <Loader2 size={15} className="animate-spin" />
                          Starting camera…
                        </span>
                      </div>
                    )}
                    <div className="pointer-events-none absolute inset-[18%] rounded-[16px] border-2 border-white/80" />
                    <ScanLine
                      size={18}
                      className="pointer-events-none absolute top-3 left-3 text-white/70"
                    />
                  </div>
                )}

                {camera === "denied" && (
                  <p className="m-0 flex items-start gap-2 rounded-xl bg-clay px-3 py-2.5 text-[12px] leading-relaxed text-clay-ink">
                    <Camera size={14} strokeWidth={2.2} className="mt-px shrink-0" />
                    The camera was refused. Type the token instead, or allow it in the address bar
                    and reopen this.
                  </p>
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    resolve(typed);
                  }}
                  className="mt-3.5 flex gap-2"
                >
                  <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface px-3">
                    <Keyboard size={14} strokeWidth={2.2} className="shrink-0 text-faint" />
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value.toUpperCase())}
                      placeholder="Token, e.g. A03"
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      className="h-11 min-w-0 flex-1 bg-transparent font-mono text-[15px] tracking-wider outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-faint"
                    />
                  </label>
                  <button
                    type="submit"
                    className={cn(
                      "h-11 rounded-xl px-4 text-[13.5px] font-semibold",
                      typed ? "bg-ink text-paper" : "border border-line text-faint",
                    )}
                  >
                    Find
                  </button>
                </form>

                {miss && <p className="m-0 mt-2.5 text-[12px] text-clay-ink dark:text-clay">{miss}</p>}

                <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">
                  {ready.length === 0
                    ? "Nothing is waiting to be collected right now."
                    : `${ready.length} ${ready.length === 1 ? "order is" : "orders are"} on the shelf.`}
                </p>
              </>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/**
 * The order the scan found, and how sure the desk should be.
 *
 * Verified: the code came from the student's own screen. Unverified: a slip
 * or a typed token found it, so check the name — it's shown for exactly that.
 * Wrong: the QR carried a code and it doesn't belong to this order; nothing
 * is offered, because a QR someone made up is the one case this exists for.
 */
function MatchPanel({
  order,
  proof,
  busy,
  onHandOver,
  onDismiss,
}: {
  order: OrderRow;
  proof: Proof;
  busy: boolean;
  onHandOver: () => void;
  onDismiss: () => void;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);

  useEffect(() => {
    setCustomer(null);
    void orderCustomer(order.user_id).then(setCustomer);
  }, [order.user_id]);

  const tone =
    proof === "verified"
      ? "border-sage bg-sage/30"
      : proof === "wrong"
        ? "border-clay bg-clay/30"
        : "border-line bg-surface";

  return (
    <div className={cn("rounded-[20px] border p-4", tone)}>
      <p className="m-0 flex items-center gap-1.5 font-mono text-[11px] tracking-[0.1em] uppercase">
        {proof === "verified" ? (
          <>
            <ShieldCheck size={13} strokeWidth={2.4} className="text-sage-ink" />
            <span className="text-sage-ink">Their phone — verified</span>
          </>
        ) : proof === "wrong" ? (
          <>
            <ShieldAlert size={13} strokeWidth={2.4} className="text-clay-ink" />
            <span className="text-clay-ink">Code doesn&apos;t match this order</span>
          </>
        ) : (
          <>
            <ShieldAlert size={13} strokeWidth={2.4} className="text-muted" />
            <span className="text-muted">Found, not verified — check the name</span>
          </>
        )}
      </p>

      <p className="font-figure m-0 mt-1 text-[44px] leading-none font-extrabold">{order.token}</p>

      <p className="m-0 mt-2 text-[13px]">
        {order.order_items?.[0]?.name ?? `${order.pages} pages`}
        {(order.order_items?.length ?? 0) > 1 ? ` + ${order.order_items!.length - 1} more` : ""}
        {" · "}
        {order.pages} p
      </p>
      <p className="m-0 mt-1 text-[13px]">
        <span className="font-semibold">{customer?.name ?? "\u2026"}</span>
        {customer?.roll_no && (
          <span className="ml-2 font-mono text-[11.5px] text-muted">{customer.roll_no}</span>
        )}
      </p>

      {proof === "wrong" ? (
        <p className="m-0 mt-3 text-[12px] leading-relaxed text-clay-ink">
          This QR names {order.token} but its code belongs to nobody on the shelf. A made-up code, or
          one from another day. Don&apos;t hand it over on this scan — ask them to open the order on
          their own phone.
        </p>
      ) : (
        <div className="mt-4 flex gap-2">
          <motion.button
            whileTap={{ scale: 0.98 }}
            transition={spring}
            disabled={busy}
            onClick={onHandOver}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-ink text-[14px] font-semibold text-paper disabled:opacity-60"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} strokeWidth={2.6} />}
            Handed over
          </motion.button>
          <button
            onClick={onDismiss}
            className="h-12 rounded-xl border border-line px-4 text-[13.5px] font-semibold text-ink-soft"
          >
            Not this one
          </button>
        </div>
      )}
      {proof === "wrong" && (
        <button
          onClick={onDismiss}
          className="mt-3 h-11 w-full rounded-xl border border-line text-[13.5px] font-semibold text-ink-soft"
        >
          Scan again
        </button>
      )}
    </div>
  );
}
