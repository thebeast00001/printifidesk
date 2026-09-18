"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bike, Footprints } from "lucide-react";
import { platformSettings, type PlatformSettings } from "@/lib/platform";
import { ensureSession, getSupabase } from "@/lib/supabase/client";
import { money } from "@/lib/pricing";
import type { Operator } from "@/lib/orders";
import { cn, easeIos, spring } from "@/lib/utils";
import { SpotFields, roundPhrase, spotProblem, type SpotDraft } from "./spot-fields";

/** Where a delivery goes, and the phone the runner calls — what the student fills in. */
export interface DeliveryDraft extends SpotDraft {
  phone: string;
}

/** The spot and detail a student chose last time, kept on this device. */
const LAST_SPOT_KEY = "printify.delivery.last";

/**
 * Delivery to where the student will be (0046, reshaped by 0047), offered
 * under the pickup choice when the platform has it on and this desk is
 * one the runner collects from.
 *
 * The question is framed by the round — "the 1:00 pm round: where will
 * you be?" — not by where they are now. The spot comes from the admin's
 * list, the detail is theirs, the phone is the profile's (kept there, since
 * place_order reads it). The spot can be changed from the status capsule
 * any time until it's handed over. The fee is the platform's, shown as a
 * line.
 */
export function DeliveryPicker({
  operator,
  value,
  onChange,
  disabled,
}: {
  operator: Operator | null;
  /** Null: collect at the desk. */
  value: DeliveryDraft | null;
  onChange: (next: DeliveryDraft | null) => void;
  /** A booked pickup time: delivery can't go with one. */
  disabled?: boolean;
}) {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [phone, setPhone] = useState<string | null>(null);

  useEffect(() => {
    void platformSettings().then(setSettings);
    void (async () => {
      const session = await ensureSession();
      if (session.status !== "ready") return setPhone("");
      const { data } = await getSupabase()!.from("profiles").select("phone").eq("id", session.userId).maybeSingle();
      setPhone(((data as { phone?: string | null } | null)?.phone ?? "").trim());
    })();
  }, []);

  const offered = Boolean(settings?.delivery_enabled && operator?.delivery);
  if (!settings || !offered) return null;

  const fee = settings.delivery_fee;
  const cur = operator?.currency ?? "₹";
  const round = roundPhrase(settings);

  function choose(on: boolean) {
    if (!on) return onChange(null);
    // Last time's spot, if it's still on the list; else nothing chosen yet.
    let last: Partial<SpotDraft> = {};
    try {
      last = JSON.parse(localStorage.getItem(LAST_SPOT_KEY) ?? "{}") as Partial<SpotDraft>;
    } catch {
      /* no memory of a last spot; fine */
    }
    const listed = settings!.delivery_areas.length > 0;
    const spot = last.spot && (!listed || settings!.delivery_areas.includes(last.spot)) ? last.spot : "";
    onChange({ spot, detail: spot ? (last.detail ?? "") : "", phone: phone ?? "" });
  }

  return (
    <div className="mt-[18px]">
      <p className="label-caps m-0 mb-2.5">Get it</p>
      <div className="flex flex-wrap gap-[7px]">
        <Choice active={value === null} onClick={() => choose(false)} icon={<Footprints size={13} strokeWidth={2.2} />} label="At the desk" />
        <Choice
          active={value !== null}
          onClick={() => !disabled && choose(true)}
          icon={<Bike size={13} strokeWidth={2.2} />}
          label={`Brought to me · +${money(fee, cur)}`}
          dim={disabled}
        />
      </div>
      {disabled && value === null && (
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted">
          Delivery goes out on the runner&apos;s next round, so it can&apos;t take a booked pickup time — choose
          &ldquo;as soon as possible&rdquo; above to have it brought to you.
        </p>
      )}

      <AnimatePresence initial={false}>
        {value !== null && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: easeIos }}
            className="overflow-hidden"
          >
            <div className="mt-3 rounded-[16px] border border-line bg-surface p-3.5">
              <p className="m-0 mb-3 text-[13px] font-semibold tracking-[-0.01em]">
                It comes on {round}. Where will you be?
              </p>
              <SpotFields settings={settings} value={value} onChange={(next) => onChange({ ...value, ...next })} />
              <label className="mt-3 flex flex-col gap-1">
                <span className="text-[11.5px] font-semibold text-ink-soft">Phone — the runner calls this if they can&apos;t see you</span>
                <input
                  value={value.phone}
                  inputMode="tel"
                  autoComplete="tel"
                  onChange={(e) => onChange({ ...value, phone: e.target.value })}
                  placeholder="10 digits"
                  className="h-11 w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[14px] outline-none placeholder:text-faint focus:border-ink"
                />
              </label>
              <p className="m-0 mt-3 text-[11.5px] leading-snug text-muted">
                {settings.delivery_note?.trim() ? `${settings.delivery_note.trim()} ` : ""}
                Somewhere else by then? Change the spot from your order any time before it&apos;s handed over — the
                runner is told. Have your token&apos;s QR ready; it&apos;s what they scan.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Remembers the spot for next time — a per-device convenience, nothing more. */
export function rememberSpot(draft: SpotDraft) {
  try {
    localStorage.setItem(LAST_SPOT_KEY, JSON.stringify({ spot: draft.spot.trim(), detail: draft.detail.trim() }));
  } catch {
    /* storage blocked; the next order asks again */
  }
}

/** Whether a draft is complete enough to send. The database checks it again. */
export function deliveryProblem(draft: DeliveryDraft | null): string | null {
  if (!draft) return null;
  const spot = spotProblem(draft);
  if (spot) return spot;
  if (draft.phone.replace(/\D/g, "").length < 8) return "A phone number the runner can call.";
  return null;
}

function Choice({ active, onClick, label, icon, dim }: { active: boolean; onClick: () => void; label: string; icon: React.ReactNode; dim?: boolean }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: dim ? 1 : 0.97 }}
      transition={spring}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-semibold transition-colors",
        active ? "border-ink bg-ink text-paper" : "border-line bg-surface text-ink-soft",
        dim && !active && "opacity-50",
      )}
    >
      {icon}
      {label}
    </motion.button>
  );
}
