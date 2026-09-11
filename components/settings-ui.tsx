"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { cn, spring } from "@/lib/utils";

export function SettingsGroup({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section data-anim="settings-group" className="flex flex-col">
      <h2 className="label-caps mb-2.5 px-1">{title}</h2>
      <div className="divide-y divide-line overflow-hidden rounded-[20px] border border-line bg-surface shadow-card">
        {children}
      </div>
      {note && <p className="mt-2.5 mb-0 px-1 text-[12px] leading-relaxed text-muted">{note}</p>}
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 lg:px-5">
      <div className="min-w-0">
        <p className="m-0 text-[14px] font-semibold tracking-[-0.01em]">{label}</p>
        {description && (
          <p className="m-0 mt-1 max-w-[52ch] text-[12.5px] leading-relaxed text-muted">
            {description}
          </p>
        )}
      </div>
      {/* `self-start` matters on a phone: the row stacks, and a flex child
          in a column stretches to the full width by default — so a
          three-option pill grew to the edge of the card with a long empty
          tail. Every control here is a pill or a button; none wants that. */}
      <div className="shrink-0 self-start sm:self-center">{control}</div>
    </div>
  );
}

/** Segmented picker. The ink pill is a shared layout element, so it slides. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  id,
}: {
  value: T;
  options: { value: T; label: string; icon?: React.ComponentType<{ size?: number; strokeWidth?: number }> }[];
  onChange: (value: T) => void;
  id: string;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-line bg-surface-sunk p-1">
      {options.map(({ value: v, label, icon: Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            onClick={() => onChange(v)}
            aria-pressed={active}
            className={cn(
              "relative rounded-full px-3.5 py-2 text-[12.5px] font-semibold whitespace-nowrap transition-colors",
              active ? "text-paper" : "text-muted hover:text-ink-soft",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring}
                className="absolute inset-0 rounded-full bg-ink"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {Icon && <Icon size={13} strokeWidth={2.2} />}
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Renders children only after mount — for anything that reads the real theme. */
export function ClientOnly({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-[43px]" aria-hidden />;
  return <>{children}</>;
}
