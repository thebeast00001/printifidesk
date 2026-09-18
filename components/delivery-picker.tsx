"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bike, Footprints } from "lucide-react";
import { platformSettings, type PlatformSettings } from "@/lib/platform";
import { ensureSession, getSupabase } from "@/lib/supabase/client";
import { money } from "@/lib/pricing";
import type { Operator } from "@/lib/orders";
import { cn, easeIos, spring } from "@/lib/utils";

/** Where a delivery goes, and the phone the runner calls — what the student fills in. */
export interface DeliveryDraft {
  hostel: string;
  room: string;
  phone: string;
}

/**
 * Delivery to the door (0046), offered under the pickup choice when the
 * platform has it on and this desk is one the runner collects from.
 *
 * The hostel comes from the admin's list (free text when there is none),
 * the room and phone from the profile, pre-filled and editable here — and
 * saved back to the profile when the order is placed, so the next time
 * they're already there. The fee is the platform's, shown as a line.
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
  const [profile, setProfile] = useState<{ hostel: string; room: string; phone: string } | null>(null);

  useEffect(() => {
    void platformSettings().then(setSettings);
    void (async () => {
      const session = await ensureSession();
      if (session.status !== "ready") return setProfile({ hostel: "", room: "", phone: "" });
      const { data } = await getSupabase()!.from("profiles").select("hostel, room, phone").eq("id", session.userId).maybeSingle();
      const row = (data as { hostel?: string | null; room?: string | null; phone?: string | null } | null) ?? {};
      setProfile({ hostel: row.hostel ?? "", room: row.room ?? "", phone: row.phone ?? "" });
    })();
  }, []);

  const offered = Boolean(settings?.delivery_enabled && operator?.delivery);
  if (!settings || !offered) return null;

  const areas = settings.delivery_areas;
  const fee = settings.delivery_fee;
  const cur = operator?.currency ?? "₹";
  const listed = areas.length > 0;

  function choose(on: boolean) {
    if (!on) return onChange(null);
    const p = profile ?? { hostel: "", room: "", phone: "" };
    // A saved hostel that isn't on the list today reads as none chosen.
    const hostel = listed ? (areas.includes(p.hostel) ? p.hostel : "") : p.hostel;
    onChange({ hostel, room: p.room, phone: p.phone });
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
          label={`Delivered to my room · +${money(fee, cur)}`}
          dim={disabled}
        />
      </div>
      {disabled && value === null && (
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted">
          Delivery goes out on the runner&apos;s next round, so it can&apos;t take a booked pickup time — choose
          &ldquo;as soon as possible&rdquo; above to have it delivered.
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
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2.5 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] font-semibold text-ink-soft">Hostel</span>
                {listed ? (
                  <select
                    value={value.hostel}
                    onChange={(e) => onChange({ ...value, hostel: e.target.value })}
                    className="h-11 w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[14px] outline-none focus:border-ink"
                  >
                    <option value="">Choose your hostel</option>
                    {areas.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={value.hostel}
                    maxLength={60}
                    onChange={(e) => onChange({ ...value, hostel: e.target.value })}
                    placeholder="e.g. Ganga Hostel"
                    className="h-11 w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[14px] outline-none placeholder:text-faint focus:border-ink"
                  />
                )}
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] font-semibold text-ink-soft">Room</span>
                <input
                  value={value.room}
                  maxLength={20}
                  onChange={(e) => onChange({ ...value, room: e.target.value })}
                  placeholder="e.g. 213"
                  className="h-11 w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[14px] outline-none placeholder:text-faint focus:border-ink"
                />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-[11.5px] font-semibold text-ink-soft">Phone — the runner calls this at the door</span>
                <input
                  value={value.phone}
                  inputMode="tel"
                  autoComplete="tel"
                  onChange={(e) => onChange({ ...value, phone: e.target.value })}
                  placeholder="10 digits"
                  className="h-11 w-full min-w-0 rounded-xl border border-line bg-surface-sunk px-3 text-[14px] outline-none placeholder:text-faint focus:border-ink"
                />
              </label>
            </div>
            <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted">
              {settings.delivery_note?.trim() || "Goes out on the runner's next round."} Have your token&apos;s QR ready at the door
              {" — "}it&apos;s what the runner scans to hand it over. Saved to your profile for next time.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Whether a draft is complete enough to send. The database checks it again. */
export function deliveryProblem(draft: DeliveryDraft | null): string | null {
  if (!draft) return null;
  if (!draft.hostel.trim()) return "Which hostel should it come to?";
  if (!draft.room.trim()) return "Which room should it come to?";
  if (draft.phone.replace(/\D/g, "").length < 8) return "A phone number the runner can call at the door.";
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
