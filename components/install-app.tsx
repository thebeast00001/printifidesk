"use client";

import { useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import { Bell, Check, Download, Loader2, PlusSquare, Share, Smartphone, Zap } from "lucide-react";
import { canInstall, install, useInstall } from "@/lib/install";
import { useApp } from "@/lib/store";
import { cn, spring } from "@/lib/utils";

/**
 * "Install" — a pill in the header and a row on the profile, shown only when
 * there is something to do: Chrome has handed us its prompt, or this is an
 * iPhone/iPad where the install is a Share-sheet gesture we can walk
 * through. Already installed, or a browser with no way to install: nothing
 * is drawn, so the site never nags. The sheet itself lives in AppChrome.
 */
export function InstallPill({ className }: { className?: string }) {
  const state = useInstall();
  const setOpen = useApp((s) => s.setInstallOpen);
  if (!canInstall(state)) return null;
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      transition={spring}
      onClick={() => setOpen(true)}
      className={cn(
        "flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] font-semibold shadow-card transition-colors hover:bg-surface-sunk",
        className,
      )}
    >
      <Download size={15} strokeWidth={2.2} />
      Install
    </motion.button>
  );
}

/** For a settings list: the same thing as a row. Renders nothing when there's nothing to offer. */
export function InstallRow() {
  const state = useInstall();
  const setOpen = useApp((s) => s.setInstallOpen);
  if (!canInstall(state)) return null;
  return (
    <button
      onClick={() => setOpen(true)}
      className="flex w-full items-center justify-between gap-6 p-4 text-left transition-colors hover:bg-surface-sunk lg:px-5"
    >
      <span className="flex min-w-0 items-center gap-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line bg-surface-sunk">
          <Smartphone size={16} strokeWidth={2} />
        </span>
        <span className="min-w-0">
          <span className="block text-[13.5px] font-semibold tracking-[-0.01em]">Install the app</span>
          <span className="mt-0.5 block text-[12px] text-muted">
            On your home screen, full screen, no address bar
          </span>
        </span>
      </span>
      <Download size={15} strokeWidth={2.2} className="shrink-0 text-faint" />
    </button>
  );
}

/**
 * The sheet. What it shows depends on what the browser can do:
 *
 *   Chrome's prompt in hand → an Install button that fires the browser's own
 *                             dialog; accepted, the sheet says so.
 *   iOS                     → the three Share-sheet steps, because Safari
 *                             has no dialog to fire.
 *   prompt turned down      → the menu route, so the tap still goes somewhere.
 *   installed               → "you're set", nothing more to do.
 */
export function InstallDrawer() {
  const open = useApp((s) => s.installOpen);
  const setOpen = useApp((s) => s.setInstallOpen);
  const state = useInstall();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"dismissed" | "unavailable" | null>(null);

  async function go() {
    setBusy(true);
    setOutcome(null);
    const result = await install();
    if (result !== "accepted") setOutcome(result);
    setBusy(false);
  }

  return (
    <Drawer.Root open={open} onOpenChange={setOpen}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-[rgb(12_12_14/0.42)] backdrop-blur-[3px]" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-60 mx-auto flex max-h-[85dvh] w-full max-w-[520px] flex-col
                     rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]"
        >
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-4 pb-[max(24px,env(safe-area-inset-bottom))]">
            <div className="flex items-center gap-3.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon-192.png" alt="" className="size-14 rounded-[16px] border border-line" />
              <div className="min-w-0">
                <Drawer.Title className="font-figure m-0 text-[22px] leading-tight font-extrabold">
                  Printify on your home screen
                </Drawer.Title>
                <Drawer.Description className="m-0 mt-0.5 text-[12.5px] text-muted">
                  It&apos;s this site, installed — nothing from an app store.
                </Drawer.Description>
              </div>
            </div>

            {state.installed ? (
              <div className="mt-5 flex gap-3 rounded-[16px] bg-sage px-4 py-3.5 text-[13px] leading-relaxed text-sage-ink">
                <Check size={16} strokeWidth={2.4} className="mt-px shrink-0" />
                <span>
                  <b className="font-bold">You&apos;re set.</b> Open Printify from your home screen like
                  any other app.
                </span>
              </div>
            ) : (
              <>
                <ul className="m-0 mt-5 flex list-none flex-col gap-2.5 p-0">
                  <Benefit icon={Zap}>Opens in a second, full screen — no address bar in the way.</Benefit>
                  <Benefit icon={Bell}>
                    Turn on notifications and your token arrives as one the moment the desk marks it
                    ready.
                  </Benefit>
                  <Benefit icon={Smartphone}>
                    Your sign-in, files and orders, one tap from the home screen.
                  </Benefit>
                </ul>

                {state.prompt ? (
                  <button
                    onClick={() => void go()}
                    disabled={busy}
                    className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-[14px] bg-ink text-[14px] font-semibold text-paper disabled:opacity-60"
                  >
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} strokeWidth={2.2} />}
                    Install
                  </button>
                ) : state.platform === "ios" ? (
                  <Steps
                    title="From the Share sheet"
                    steps={[
                      <>
                        Tap <b className="font-semibold">Share</b>{" "}
                        <Share size={13} strokeWidth={2.2} className="inline -mt-0.5" /> — at the
                        bottom of Safari, top right in Chrome.
                      </>,
                      <>
                        Scroll down and tap <b className="font-semibold">Add to Home Screen</b>{" "}
                        <PlusSquare size={13} strokeWidth={2.2} className="inline -mt-0.5" />.
                      </>,
                      <>
                        Tap <b className="font-semibold">Add</b>. Printify lands next to your other
                        apps.
                      </>,
                    ]}
                  />
                ) : (
                  <Steps
                    title="From the browser menu"
                    steps={[
                      <>
                        Open Chrome&apos;s menu — the <b className="font-semibold">⋮</b> at the top
                        right.
                      </>,
                      <>
                        Tap <b className="font-semibold">Install app</b> (or{" "}
                        <b className="font-semibold">Add to Home screen</b>), then confirm.
                      </>,
                    ]}
                  />
                )}

                {outcome === "dismissed" && (
                  <p className="m-0 mt-3 text-center text-[12px] text-muted">
                    No problem — it&apos;s here whenever you want it.
                  </p>
                )}
                {outcome === "unavailable" && (
                  <p className="m-0 mt-3 text-center text-[12px] text-muted">
                    The browser didn&apos;t open its dialog. The menu route above still works.
                  </p>
                )}
              </>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function Benefit({ icon: Icon, children }: { icon: typeof Zap; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-[13px] leading-relaxed text-ink-soft">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[9px] border border-line bg-surface">
        <Icon size={14} strokeWidth={2.2} />
      </span>
      <span>{children}</span>
    </li>
  );
}

function Steps({ title, steps }: { title: string; steps: React.ReactNode[] }) {
  return (
    <div className="mt-5 rounded-[18px] border border-line bg-surface p-4">
      <p className="label-caps m-0 mb-2.5">{title}</p>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3 text-[13px] leading-relaxed text-ink-soft">
            <span className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-ink font-mono text-[11px] font-semibold text-paper">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
