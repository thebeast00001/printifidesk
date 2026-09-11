"use client";

import { motion } from "motion/react";
import { cn, spring } from "@/lib/utils";

/**
 * Widget anatomy, kept as one object so every widget shares the same edges:
 *   Shell   — black body, 5px inset
 *     Panel — tinted face with four corner bolts
 *     Base  — split action row divided by a hairline
 */

export function WidgetShell({ children, className }: React.ComponentProps<"div">) {
  return (
    <motion.div
      layout
      transition={spring}
      className={cn(
        "flex flex-col rounded-[26px] bg-shell p-[5px] pb-0 shadow-lift",
        /* On the dark ground the shell is darker than the page, so it needs a
           hairline to read as an object rather than a hole. */
        "dark:ring-1 dark:ring-shell-line",
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

const TONES = {
  sage: "bg-sage text-sage-ink",
  clay: "bg-clay text-clay-ink",
  bone: "bg-bone text-ink",
} as const;

export function WidgetPanel({
  tone,
  children,
  className,
}: {
  tone: keyof typeof TONES;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      layout
      transition={spring}
      className={cn(
        "relative flex min-h-[132px] flex-col items-center justify-center overflow-hidden rounded-[21px] px-3.5 pt-5 pb-[17px] text-center",
        TONES[tone],
        className,
      )}
    >
      <Bolts />
      {children}
    </motion.div>
  );
}

function Bolts() {
  return (
    <>
      {(["top-2.5 left-2.5", "top-2.5 right-2.5", "bottom-2.5 left-2.5", "bottom-2.5 right-2.5"] as const).map(
        (pos) => (
          <i key={pos} className={cn("absolute size-[5px] rounded-full bg-current opacity-30", pos)} />
        ),
      )}
    </>
  );
}

export function WidgetBase({ children }: { children: React.ReactNode }) {
  return <div className="flex h-[50px] items-stretch">{children}</div>;
}

export function WidgetAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  onClick?: () => void;
}) {
  return (
    <motion.button
      whileTap={{ opacity: 0.45 }}
      onClick={onClick}
      /* `min-w-0` plus a truncating label: these sit two-across in a half-width
         column, so a long word would otherwise run under the centre divider. */
      className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 text-[12.5px] font-semibold text-shell-ink"
    >
      <Icon size={13} strokeWidth={2.2} />
      <span className="truncate">{label}</span>
    </motion.button>
  );
}

export function WidgetDivider() {
  return <span className="my-[13px] w-px bg-shell-line" />;
}

/** The coin cluster from the reference — overlapping ringed discs. */
export function Cluster({ items }: { items: string[] }) {
  return (
    <span className="mb-2.5 flex">
      {items.map((c, i) => (
        <span
          key={c}
          style={{ marginLeft: i === 0 ? 0 : -5 }}
          className="grid size-[19px] place-items-center rounded-full border-[1.5px] border-current bg-current/10 text-[9px] font-bold"
        >
          {c}
        </span>
      ))}
    </span>
  );
}
