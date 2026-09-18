"use client";

import { useEffect, useState } from "react";
import { Drawer } from "vaul";
import { Check, Loader2, MapPin } from "lucide-react";
import { setDeliverySpot } from "@/lib/delivery";
import { platformSettings, type PlatformSettings } from "@/lib/platform";
import { deliverySpot, type OrderRow } from "@/lib/orders";
import { SpotFields, roundPhrase, spotProblem, type SpotDraft } from "./spot-fields";
import { rememberSpot } from "./delivery-picker";

/**
 * "Where will you be?" — the student moves a live delivery (0047). Before
 * the runner sets off it's a quiet edit; once it's on its way the runner is
 * pushed the new spot the moment this saves, and the sheet says so.
 */
export function SpotSheet({
  order,
  open,
  onOpenChange,
  onChanged,
}: {
  order: OrderRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [draft, setDraft] = useState<SpotDraft>(() => deliverySpot(order));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(deliverySpot(order));
    setError(null);
    void platformSettings().then(setSettings);
  }, [open, order]);

  const onItsWay = order.status === "delivering";
  const problem = spotProblem(draft);
  const unchanged = JSON.stringify(draft) === JSON.stringify(deliverySpot(order));

  async function save() {
    if (busy || problem || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      await setDeliverySpot(order.id, draft.spot, draft.detail);
      rememberSpot(draft);
      onChanged();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.45)] backdrop-blur-[3px]" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-80 mx-auto flex max-h-[92dvh] w-full max-w-[520px] flex-col rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]">
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <Drawer.Title className="font-figure m-0 mb-1 flex items-center gap-2 text-[23px] font-extrabold">
              <MapPin size={20} strokeWidth={2.2} />
              Where will you be?
            </Drawer.Title>
            <Drawer.Description className="m-0 mb-4 text-[13px] text-muted">
              {onItsWay
                ? `Order ${order.token ?? ""} is already on its way — the runner is told the new spot the moment you save.`
                : settings
                  ? `Order ${order.token ?? ""} comes on ${roundPhrase(settings)}. Change the spot any time before it's handed over.`
                  : `Order ${order.token ?? ""} comes on the next round.`}
            </Drawer.Description>

            {settings ? (
              <SpotFields settings={settings} value={draft} onChange={setDraft} autoFocus />
            ) : (
              <p className="m-0 flex items-center gap-2 text-[12.5px] text-muted">
                <Loader2 size={13} className="animate-spin" />
                Loading…
              </p>
            )}

            {error && <p className="m-0 mt-2.5 text-[12px] text-clay-ink dark:text-clay">{error}</p>}

            <button
              disabled={busy || Boolean(problem) || unchanged || !settings}
              onClick={() => void save()}
              className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-ink text-[15px] font-semibold text-paper disabled:opacity-40"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} strokeWidth={2.6} />}
              {onItsWay ? "Tell the runner" : "Save the spot"}
            </button>
            {problem && !unchanged && <p className="m-0 mt-2 text-center text-[11.5px] text-muted">{problem}</p>}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
