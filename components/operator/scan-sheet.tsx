"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import jsQR from "jsqr";
import { Banknote, Camera, Check, FileCheck, ImageUp, Keyboard, Loader2, ScanLine, ShieldAlert, ShieldCheck } from "lucide-react";
import { advance, orderCustomer, type Customer } from "@/lib/operator";
import { duesOf, listOperators, paymentBalance, settleDuesCash, type OrderRow } from "@/lib/orders";
import { money } from "@/lib/pricing";
import { cn, spring } from "@/lib/utils";

/**
 * The student holds up their code; the desk points a phone at it.
 *
 * Decoding: the browser's own `BarcodeDetector` where it genuinely reads QR
 * codes, and jsQR — a small pure-JS decoder bundled with the app — everywhere
 * else. "Genuinely" matters: on Windows Chrome the constructor exists but
 * supports no formats, and the first version of this trusted the constructor,
 * started the camera, and decoded nothing for as long as you cared to wait.
 *
 * Where the live camera can't run at all — the API needs a secure context,
 * and a phone opening the dev server over plain http on the LAN doesn't have
 * one — the native camera can still take a photo through a file input, and
 * that photo is decoded the same way.
 *
 * The one thing any of this decides is *which* order is in front of you;
 * handing it over is still a tap, because a scan of the wrong student's phone
 * must not be a completed handover.
 */

/**
 * What a scan or a typed token says.
 *
 * The student's code is `printify:order:A03:7F3A9C21:5E9A1C2B` — token,
 * secret, and the first eight characters of the desk it was placed with.
 * The slip's is `printify:order:A03` — token only, because whoever holds
 * the slip already holds the paper, and it exists to *find*, not to prove.
 * A typed token is the same as a slip. Codes from before the desk segment
 * existed still parse; they just can't name their desk.
 */
/**
 * The cover sheet's code (0044): the token and the desk, nothing else. Used
 * to file a job (mark it ready) or to find one — never to prove who's
 * collecting; that stays with the phone.
 */
export function parseCoverScan(raw: string): { token: string; desk: string } | null {
  const m = /^printify:cover:([A-Z]{1,2}\d{1,4}):([A-F0-9]{8})$/i.exec(raw.trim());
  return m ? { token: m[1].toUpperCase(), desk: m[2].toUpperCase() } : null;
}

/** A student's dues code (0043): who owes, so the desk can look up how much. */
export function parseDuesScan(raw: string): string | null {
  const m = /^printify:dues:([A-Za-z0-9_-]{4,64})$/.exec(raw.trim());
  return m ? m[1] : null;
}

export function parseScan(
  raw: string,
): { token: string; code: string | null; desk: string | null } | null {
  const text = raw.trim();
  const m = /^printify:order:([A-Z0-9-]+)(?::([A-Z0-9]{6,16}))?(?::([A-F0-9]{8}))?$/i.exec(text);
  const token = (m ? m[1] : text).toUpperCase();
  if (!/^[A-Z]{1,2}\d{1,4}$/.test(token)) return null;
  return {
    token,
    code: m?.[2] ? m[2].toUpperCase() : null,
    desk: m?.[3] ? m[3].toUpperCase() : null,
  };
}

/** The desk segment for an operator id: the first eight hex characters. */
export function deskPrefix(operatorId: string): string {
  return operatorId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

/** Kept for callers that only want the token. */
export function tokenFromScan(raw: string): string | null {
  return parseScan(raw)?.token ?? null;
}

type Proof = "verified" | "unverified" | "wrong";

interface Detector {
  detect(source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): Promise<{ rawValue: string }[]>;
}

interface DetectorCtor {
  new (o: { formats: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
}

/**
 * The native detector, only if it can actually read QR codes on this
 * platform. Resolves null otherwise, and jsQR takes over.
 */
async function nativeDetector(): Promise<Detector | null> {
  const ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (!ctor) return null;
  try {
    const formats = ctor.getSupportedFormats ? await ctor.getSupportedFormats() : [];
    if (!formats.includes("qr_code")) return null;
    return new ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

/**
 * Reads a QR from pixels. Used for every camera frame when the native
 * detector isn't there, and for a photo whichever detector is there — a
 * photo is a still, and this is simpler than wrapping one for the API.
 */
export function decodePixels(source: HTMLVideoElement | HTMLImageElement, scratch: HTMLCanvasElement): string | null {
  const w = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const h = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  if (!w || !h) return null;

  // Downscale big frames: a 4K still is slow to search and a QR the size of a
  // phone screen is still hundreds of pixels wide at 800.
  const scale = Math.min(1, 800 / Math.max(w, h));
  scratch.width = Math.round(w * scale);
  scratch.height = Math.round(h * scale);
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, scratch.width, scratch.height);
  const image = ctx.getImageData(0, 0, scratch.width, scratch.height);
  const hit = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
  return hit?.data ?? null;
}

/** Whether `getUserMedia` can run here at all. */
const secure = () => typeof window !== "undefined" && window.isSecureContext;

export function ScanSheet({
  open,
  onOpenChange,
  operatorId,
  ready,
  live,
  busy,
  onHandOver,
  onFiled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The desk doing the scanning. */
  operatorId: string;
  /** Orders currently waiting to be collected here. */
  ready: OrderRow[];
  /** 0044: every live order here, so a cover sheet's code can file one (mark it ready). */
  live?: OrderRow[];
  busy: boolean;
  onHandOver: (order: OrderRow) => void;
  /** 0044: a cover was scanned and the job marked ready; the list should reload. */
  onFiled?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  // The live camera needs a secure context; a photo through a file input does not.
  const [supported] = useState(() => secure());
  const [camera, setCamera] = useState<"idle" | "starting" | "on" | "denied">("idle");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [match, setMatch] = useState<{ order: OrderRow; proof: Proof } | null>(null);
  /** A dues code (0043): the student, what they owe, and the settling. */
  const [dues, setDues] = useState<{ user_id: string; name: string | null; dues: number } | null>(null);
  /** A cover code (0044) for a job not yet ready: filing it. */
  const [filing, setFiling] = useState<{ order: OrderRow; done: boolean; error: string | null } | null>(null);
  const [duesBusy, setDuesBusy] = useState(false);
  const [duesDone, setDuesDone] = useState<string | null>(null);
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
      // A dues code first: it isn't a token and never matches one.
      const owing = parseDuesScan(raw);
      if (owing) {
        setMiss(null);
        setMatch(null);
        setChoices([]);
        setDuesDone(null);
        void duesOf(owing).then((d) => {
          if (!d) return setMiss("Couldn't read that student's dues — are you signed in to a desk?");
          if (d.dues <= 0) return setMiss(`${d.name ?? "This student"} has nothing due.`);
          setDues(d);
        });
        return;
      }
      // A cover sheet: this desk's? Then either find the pile (ready) or file it.
      const cover = parseCoverScan(raw);
      if (cover) {
        if (cover.desk !== deskPrefix(operatorId)) {
          setMiss("That cover sheet is from another desk.");
          return;
        }
        const onShelf = ready.filter((o) => o.token?.toUpperCase() === cover.token);
        if (onShelf.length === 1) {
          setMiss(null);
          setChoices([]);
          // The paper found; who's collecting is still to be checked.
          setMatch({ order: onShelf[0], proof: "unverified" });
          return;
        }
        if (onShelf.length > 1) {
          setMiss(null);
          setChoices(onShelf);
          return;
        }
        const toFile = (live ?? []).find((o) => o.token?.toUpperCase() === cover.token && ["queued", "printing", "finishing"].includes(o.status));
        if (toFile) {
          setMiss(null);
          setFiling({ order: toFile, done: false, error: null });
          return;
        }
        setMiss(`${cover.token} isn't a live job here.`);
        return;
      }
      const parsed = parseScan(raw);
      if (!parsed) {
        setMiss("That doesn't look like a Printifi token.");
        return;
      }
      const { token, code, desk } = parsed;

      // The most common wrong scan: the right student at the wrong counter.
      // This desk can't see that order at all — RLS stops here — but the QR
      // says where it lives, and operators are public, so it can be named.
      if (desk && desk !== deskPrefix(operatorId)) {
        setMatch(null);
        setChoices([]);
        setMiss("This order was placed with another desk.");
        void listOperators().then((all) => {
          const theirs = all.find((o) => deskPrefix(o.id) === desk);
          if (theirs) {
            setMiss(
              `This order is with ${theirs.short_name?.trim() || theirs.name}${theirs.campus ? `, ${theirs.campus}` : ""} — not here. Send them there.`,
            );
          }
        });
        return;
      }

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
    [ready, live, operatorId],
  );

  // Camera loop. Runs only while the sheet is open and no order has been
  // matched — once one is, the picture is noise and the tap is what matters.
  useEffect(() => {
    if (!open || !supported || match || dues || filing) {
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

        // A few frames a second is plenty for a code held still, and jsQR
        // on the main thread wants the breathing room.
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
                raw = codes.find((c) => tokenFromScan(c.rawValue))?.rawValue ?? null;
              } else {
                const text = decodePixels(video, scratch);
                raw = text && tokenFromScan(text) ? text : null;
              }
              if (raw) {
                resolve(raw);
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
  }, [open, supported, match, dues, filing, resolve, stop]);

  useEffect(() => {
    if (!open) {
      setMatch(null);
      setChoices([]);
      setMiss(null);
      setTyped("");
      setDues(null);
      setDuesDone(null);
      setFiling(null);
    }
  }, [open]);

  /** A still from the native camera app, decoded like a frame. */
  async function readPhoto(file: File) {
    setPhotoBusy(true);
    setMiss(null);
    try {
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
        if (text && (tokenFromScan(text) || parseDuesScan(text) || parseCoverScan(text))) resolve(text);
        else setMiss("No Printifi code in that photo. Get the whole square in frame and try again.");
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      setMiss("Couldn't read that photo.");
    } finally {
      setPhotoBusy(false);
      if (photoRef.current) photoRef.current.value = "";
    }
  }

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
                ? "Point the camera at the student's code or the cover sheet, or type the token."
                : "Take a photo of the student's code or the cover sheet, or type the token."}
            </Drawer.Description>

            {filing ? (
              <div className="rounded-[20px] border border-line bg-surface p-4">
                <p className="label-caps m-0 flex items-center gap-1.5">
                  <FileCheck size={12} strokeWidth={2.4} />
                  File this job
                </p>
                <p className="font-figure m-0 mt-1 text-[44px] leading-none font-extrabold">{filing.order.token}</p>
                <p className="m-0 mt-1 text-[13px]">
                  {filing.order.order_items?.[0]?.name ?? `${filing.order.pages} pages`} · {filing.order.pages} p · {filing.order.status}
                  {filing.order.shelf_slot ? ` · shelf ${filing.order.shelf_slot}` : ""}
                </p>
                {filing.done ? (
                  <p className="m-0 mt-3 flex items-center gap-1.5 text-[13px] font-semibold text-sage-ink">
                    <Check size={14} strokeWidth={2.6} />
                    Ready{filing.order.shelf_slot ? ` on shelf ${filing.order.shelf_slot}` : ""} — the student&apos;s been told.
                  </p>
                ) : (
                  <>
                    <p className="m-0 mt-1 text-[12px] leading-relaxed text-muted">
                      Put the pile where the cover says and tap: the job is marked ready and the student gets the push.
                    </p>
                    {filing.error && <p className="m-0 mt-2 text-[12px] text-clay-ink dark:text-clay">{filing.error}</p>}
                    <div className="mt-3 flex gap-2">
                      <motion.button
                        whileTap={{ scale: 0.98 }}
                        transition={spring}
                        disabled={busy}
                        onClick={async () => {
                          try {
                            await advance(filing.order.id, "ready", "Ready for pickup");
                            setFiling({ ...filing, done: true });
                            onFiled?.();
                          } catch (e) {
                            setFiling({ ...filing, error: e instanceof Error ? e.message : "Couldn't file it." });
                          }
                        }}
                        className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-ink text-[13.5px] font-semibold text-paper disabled:opacity-60"
                      >
                        <Check size={14} strokeWidth={2.6} />
                        Filed — mark ready
                      </motion.button>
                      <button onClick={() => setFiling(null)} className="h-11 rounded-xl border border-line px-4 text-[13px] font-semibold text-ink-soft">
                        Back
                      </button>
                    </div>
                  </>
                )}
                {filing.done && (
                  <button onClick={() => setFiling(null)} className="mt-3 h-11 w-full rounded-xl border border-line text-[13.5px] font-semibold text-ink-soft">
                    Next
                  </button>
                )}
              </div>
            ) : dues ? (
              <div className="rounded-[20px] border border-line bg-surface p-4">
                <p className="label-caps m-0 flex items-center gap-1.5">
                  <Banknote size={12} strokeWidth={2.4} />
                  Dues
                </p>
                <p className="font-figure m-0 mt-1 text-[24px] font-extrabold">{money(dues.dues)}</p>
                <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">
                  {dues.name ?? "This student"} owes Printifi for a cash order they didn&apos;t collect. Take it in cash
                  here: it comes off what Printifi owes you (or goes on your fee), and their account opens again.
                </p>
                {duesDone ? (
                  <p className="m-0 mt-3 flex items-center gap-1.5 text-[13px] font-semibold text-sage-ink">
                    <Check size={14} strokeWidth={2.6} />
                    {duesDone}
                  </p>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <motion.button
                      whileTap={{ scale: 0.98 }}
                      transition={spring}
                      disabled={duesBusy}
                      onClick={async () => {
                        setDuesBusy(true);
                        try {
                          const left = await settleDuesCash(operatorId, dues.user_id, dues.dues);
                          setDuesDone(left > 0 ? `Took ${money(dues.dues)} · ${money(left)} still due` : `Took ${money(dues.dues)} · settled`);
                        } catch (e) {
                          setMiss(e instanceof Error ? e.message : "Couldn't record that.");
                          setDues(null);
                        } finally {
                          setDuesBusy(false);
                        }
                      }}
                      className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-ink text-[13.5px] font-semibold text-paper disabled:opacity-60"
                    >
                      {duesBusy ? <Loader2 size={14} className="animate-spin" /> : <Banknote size={14} strokeWidth={2.2} />}
                      Took {money(dues.dues)} cash
                    </motion.button>
                    <button onClick={() => setDues(null)} className="h-11 rounded-xl border border-line px-4 text-[13px] font-semibold text-ink-soft">
                      Back
                    </button>
                  </div>
                )}
              </div>
            ) : match ? (
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
                    The camera was refused. Allow it in the address bar and reopen this, or take a
                    photo of the code below.
                  </p>
                )}

                {!supported && (
                  <p className="m-0 flex items-start gap-2 rounded-xl bg-surface-sunk px-3 py-2.5 text-[12px] leading-relaxed text-muted">
                    <Camera size={14} strokeWidth={2.2} className="mt-px shrink-0" />
                    The live camera only runs over https (or on localhost) — this page is open over
                    plain http. A photo still works.
                  </p>
                )}

                {/* The native camera app, through a file input. Works where the
                    live camera can't — no secure context needed — and is a
                    second route on phones that block getUserMedia in a PWA. */}
                <input
                  ref={photoRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void readPhoto(file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => photoRef.current?.click()}
                  disabled={photoBusy}
                  className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface text-[13px] font-semibold text-ink-soft disabled:opacity-60"
                >
                  {photoBusy ? <Loader2 size={14} className="animate-spin" /> : <ImageUp size={14} strokeWidth={2.2} />}
                  {photoBusy ? "Reading…" : "Take a photo of the code"}
                </button>

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
      {order.shelf_slot && (
        <p className="m-0 mt-1 font-mono text-[15px] font-semibold tracking-[0.1em] text-sage-ink">
          SHELF {order.shelf_slot}
        </p>
      )}

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
      {order.pay_at_pickup && !order.payment_taken_at && !order.gateway_paid_at ? (
        // 0043: printed on credit — the cash changes hands now.
        <p className="m-0 mt-2.5 rounded-xl bg-bone px-3 py-2 text-[13px] font-semibold text-ink">
          Take {money(Number(order.total))} in cash — cash at pickup.
        </p>
      ) : paymentBalance(order).short > 0 ? (
        // The one moment the desk can still take it: before the paper leaves.
        <p className="m-0 mt-2.5 rounded-xl bg-clay px-3 py-2 text-[13px] font-semibold text-clay-ink">
          Take {money(paymentBalance(order).short)} in cash — they paid{" "}
          {money(paymentBalance(order).received ?? 0)} of {money(Number(order.total))}.
        </p>
      ) : null}

      {proof === "wrong" ? (
        <p className="m-0 mt-3 text-[12px] leading-relaxed text-clay-ink">
          This QR names {order.token} but its code belongs to nobody on this shelf. Most likely an
          order placed with another desk, or one from another day; possibly made up. Don&apos;t hand
          this over on it — ask them to open the order on their own phone, which shows the desk.
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
            {order.pay_at_pickup && !order.payment_taken_at && !order.gateway_paid_at ? `Took ${money(Number(order.total))} · handed over` : "Handed over"}
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
