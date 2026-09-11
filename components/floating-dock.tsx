"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { House, Receipt, Settings2 } from "lucide-react";
import { useActiveCount } from "@/hooks/use-tracking";
import { cn, spring } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/orders", label: "Orders", icon: Receipt },
  { href: "/settings", label: "Settings", icon: Settings2 },
] as const;

/**
 * Floating nav. Always visible — it is the only way between pages, so it
 * never hides on scroll. The motion lives in the active item instead: the
 * ink pill is a shared layout element that slides between destinations while
 * the active label expands out of the icon.
 */
export function FloatingDock() {
  const pathname = usePathname();
  /* Real count of jobs still with the operator, live over the same socket. */
  const activeCount = useActiveCount();

  return (
    <nav
      aria-label="Main"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(20px,env(safe-area-inset-bottom))]"
    >
      <div
        className="pointer-events-auto flex items-center gap-1 rounded-[26px] border border-line bg-surface/[0.78] p-1.5
                   shadow-dock backdrop-blur-2xl backdrop-saturate-150"
      >
        {NAV.map(({ href, label, icon: Icon }) => {
          const badge = href === "/orders" && activeCount ? activeCount : undefined;
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);

          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-11 items-center gap-2 rounded-[20px] px-4 text-sm font-semibold transition-colors",
                active ? "text-paper" : "text-muted hover:text-ink-soft",
              )}
            >
              {active && (
                <motion.span
                  layoutId="dock-active"
                  transition={spring}
                  className="absolute inset-0 rounded-[20px] bg-ink"
                />
              )}

              <span className="relative">
                <Icon size={18} strokeWidth={2} />
                {badge && !active && (
                  <span className="absolute -top-1.5 -right-2 grid h-[17px] min-w-[17px] place-items-center rounded-full border-2 border-surface bg-ink px-1 font-mono text-[9px] font-medium text-paper">
                    {badge}
                  </span>
                )}
              </span>

              {/* Only the active destination is named — the bar stays compact
                  on a phone and still reads as labelled navigation. */}
              <motion.span
                initial={false}
                animate={{
                  width: active ? "auto" : 0,
                  opacity: active ? 1 : 0,
                  marginLeft: active ? 0 : -8,
                }}
                transition={spring}
                className="relative overflow-hidden whitespace-nowrap"
              >
                {label}
              </motion.span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
