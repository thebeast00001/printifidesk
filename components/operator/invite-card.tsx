"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, Share2 } from "lucide-react";
import { formatJoinCode, joinLink } from "@/lib/desk";
import { useNow } from "./age";
import { cn } from "@/lib/utils";

/**
 * A freshly made join code, ready to be scanned, copied or read out loud.
 *
 * The QR carries the link, not just the code, so a phone camera opens the
 * join page directly. The code is also printed in full because a code read
 * across a counter is the most common way it travels.
 */
export function InviteCard({
  code,
  expiresAt,
  label,
  who,
  className,
}: {
  code: string;
  expiresAt: string;
  label?: string | null;
  /** "Priya" or "the owner" — who this is for, in the sentence under the code. */
  who?: string;
  className?: string;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const now = useNow(30_000);
  const link = joinLink(code);

  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(link, { margin: 1, width: 360, errorCorrectionLevel: "M" })
      .then((url) => alive && setQr(url))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [link]);

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function copy() {
    try {
      await navigator.clipboard?.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard — the link is on screen, and the code is bigger still.
    }
  }

  async function share() {
    try {
      await navigator.share({ title: "Join the desk on Printifi", text: `Join code ${formatJoinCode(code)}`, url: link });
    } catch {
      // Cancelled, or not allowed here. Nothing to say.
    }
  }

  return (
    <div className={cn("rounded-[18px] border border-line bg-surface p-4", className)}>
      <div className="flex flex-wrap items-center gap-4">
        {qr && (
          // The QR is decorative to a screen reader; the code below is the content.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="" width={120} height={120} className="size-[120px] shrink-0 rounded-lg bg-white" />
        )}
        <div className="min-w-0 flex-1">
          {label && <p className="label-caps m-0">{label}</p>}
          <p className="font-heading m-0 text-[28px] font-bold tracking-[0.12em] tabular-nums">
            {formatJoinCode(code)}
          </p>
          <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted">
            {who ? `${who} opens ` : "They open "}
            the link or types this at <span className="font-mono">{shortHost(link)}/join</span>, signs in
            once, and they&apos;re on the desk. {expiryText(expiresAt, now)}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              onClick={copy}
              className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface-sunk px-3 text-[12px] font-semibold text-ink-soft"
            >
              {copied ? <Check size={13} strokeWidth={2.6} /> : <Copy size={13} strokeWidth={2.2} />}
              {copied ? "Copied" : "Copy link"}
            </button>
            {canShare && (
              <button
                onClick={share}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface-sunk px-3 text-[12px] font-semibold text-ink-soft"
              >
                <Share2 size={13} strokeWidth={2.2} />
                Share
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function shortHost(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return "";
  }
}

/** "Good for 23 h" / "Good for 40 min" / "Expired". Whole units — a countdown would be theatre. */
export function expiryText(expiresAt: string, now: number): string {
  const left = new Date(expiresAt).getTime() - now;
  if (left <= 0) return "Expired.";
  const mins = Math.round(left / 60_000);
  if (mins < 60) return `Good for ${mins} min.`;
  return `Good for ${Math.round(mins / 60)} h.`;
}
