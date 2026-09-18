"use client";

import { ChevronRight, Download } from "lucide-react";
import { canInstall, useInstall } from "@/lib/install";
import { useApp } from "@/lib/store";

/**
 * One line under the desk's name — or the runner's (0046) — until the app
 * is on the home screen. Only drawn when the browser can actually install
 * (Chrome's prompt in hand, or an iPhone's Share route); never on a device
 * that already has it.
 */
export function InstallNudge({ why }: { why: string }) {
  const state = useInstall();
  const setOpen = useApp((s) => s.setInstallOpen);
  if (!canInstall(state)) return null;
  return (
    <button
      onClick={() => setOpen(true)}
      className="flex w-full items-center gap-3 rounded-[16px] border border-line bg-surface px-4 py-3 text-left shadow-card transition-colors hover:bg-surface-sunk"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface-sunk">
        <Download size={16} strokeWidth={2.2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-semibold tracking-[-0.01em]">Install Printifi Desk on this phone</span>
        <span className="mt-0.5 block text-[12px] text-muted">{why}</span>
      </span>
      <ChevronRight size={15} strokeWidth={2.2} className="shrink-0 text-faint" />
    </button>
  );
}
