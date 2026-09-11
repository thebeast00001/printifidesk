"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import { Camera, Check, Keyboard, Loader2, ScanLine } from "lucide-react";
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

/** `printify:order:A03` → `A03`. Anything else is treated as a typed token. */
export function tokenFromScan(raw: string): string | null {
  const text = raw.trim();
  const m = /^printify:order:([A-Z0-9-]+)$/i.exec(text);
  const token = (m ? m[1] : text).toUpperCase();
  return /^[A-Z]{1,2}\d{1,4}$/.test(token) ? token : null;
}

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
  const [match, setMatch] = useState<OrderRow | null>(null);
  const [miss, setMiss] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera("idle");
  }, []);

  const resolve = useCallback(
    (raw: string) => {
      const token = tokenFromScan(raw);
      if (!token) {
        setMiss("That doesn't look like a Printify token.");
        return;
      }
      const found = ready.find((o) => o.token?.toUpperCase() === token);
      if (!found) {
        setMiss(`${token} isn't waiting to be collected here.`);
        setMatch(null);
        return;
      }
      setMiss(null);
      setMatch(found);
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
              <div className="rounded-[20px] border border-sage bg-sage/30 p-4">
                <p className="m-0 font-mono text-[11px] tracking-[0.1em] text-muted uppercase">
                  Ready to hand over
                </p>
                <p className="font-figure m-0 mt-1 text-[44px] leading-none font-extrabold">
                  {match.token}
                </p>
                <p className="m-0 mt-2 text-[13px]">
                  {match.order_items?.[0]?.name ?? `${match.pages} pages`}
                  {(match.order_items?.length ?? 0) > 1 ? ` + ${match.order_items!.length - 1} more` : ""}
                  {" · "}
                  {match.pages} p
                </p>

                <div className="mt-4 flex gap-2">
                  <motion.button
                    whileTap={{ scale: 0.98 }}
                    transition={spring}
                    disabled={busy}
                    onClick={() => onHandOver(match)}
                    className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-ink text-[14px] font-semibold text-paper disabled:opacity-60"
                  >
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} strokeWidth={2.6} />}
                    Handed over
                  </motion.button>
                  <button
                    onClick={() => setMatch(null)}
                    className="h-12 rounded-xl border border-line px-4 text-[13.5px] font-semibold text-ink-soft"
                  >
                    Not this one
                  </button>
                </div>
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
