"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Activity, House, Inbox, Printer, Receipt, Settings2, SlidersHorizontal, Store, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { adminApplications } from "@/lib/operator";
import { useActiveCount } from "@/hooks/use-tracking";
import { useApp } from "@/lib/store";
import { useSurface } from "./surface-provider";
import { cn, spring } from "@/lib/utils";

const STUDENT_NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/orders", label: "Orders", icon: Receipt },
  { href: "/settings", label: "Settings", icon: Settings2 },
] as const;

/**
 * Floating nav. Always visible — it is the only way between pages, so it
 * never hides on scroll. The motion lives in the active item instead: the
 * ink pill is a shared layout element that slides between destinations while
 * the active label expands out of the icon.
 *
 * On the desk it keeps its shape and changes its meaning. "Home" there is
 * the queue, not the student's front page — an operator who taps home
 * mid-shift wants their desk back, not a place to upload. All three
 * destinations are the desk's own pages: nothing in this bar leaves the
 * desk, and on the desk's own host there is nowhere else to go.
 */
export function FloatingDock() {
  const pathname = usePathname();
  const { isDeskPath } = useSurface();

  // A door has nowhere else to go.
  if (pathname.startsWith("/sign-in") || pathname.startsWith("/sso-callback")) return null;

  // The admin's pages get the admin's dock, on either host.
  if (pathname.startsWith("/admin") || pathname.startsWith("/diagnostics")) {
    return <AdminDock pathname={pathname} />;
  }

  return isDeskPath(pathname) ? <OperatorDock pathname={pathname} /> : <StudentDock pathname={pathname} />;
}

const ADMIN_NAV = [
  { href: "/admin", label: "Fees", icon: Receipt },
  { href: "/admin/applications", label: "Applications", icon: Inbox },
  { href: "/admin/desks", label: "Desks", icon: Store },
  { href: "/diagnostics", label: "Diagnostics", icon: Activity },
] as const;

/** Money, applications, desks, and whether the wiring is right. Nothing that leaves the admin. */
function AdminDock({ pathname }: { pathname: string }) {
  // Applications waiting to be read. Admin-only in the database, so a
  // non-admin on these pages simply gets no badge.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    adminApplications("pending")
      .then((rows) => setPending(rows.length))
      .catch(() => setPending(0));
  }, [pathname]);

  return (
    <DockShell>
      {ADMIN_NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
        const badge = href === "/admin/applications" && pending ? pending : undefined;
        return <DockItem key={href} href={href} label={label} icon={Icon} active={active} badge={badge} />;
      })}
    </DockShell>
  );
}

function StudentDock({ pathname }: { pathname: string }) {
  /* Real count of jobs still with the operator, live over the same socket. */
  const activeCount = useActiveCount();

  return (
    <DockShell>
      {STUDENT_NAV.map(({ href, label, icon: Icon }) => {
        const badge = href === "/orders" && activeCount ? activeCount : undefined;
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <DockItem key={href} href={href} label={label} icon={Icon} active={active} badge={badge} />
        );
      })}
    </DockShell>
  );
}

function OperatorDock({ pathname }: { pathname: string }) {
  const pending = useApp((s) => s.operatorPending);
  const { desk } = useSurface();
  // The three faces are real pages; the browser URL says which is active.
  // `desk()` gives the public address on this site: `/takings` on the desk
  // host, `/operator/takings` where both sites share one.
  const faces = [
    { internal: "/operator", label: "Queue", icon: Printer, badge: pending || undefined },
    { internal: "/operator/takings", label: "Takings", icon: Wallet, badge: undefined },
    { internal: "/operator/settings", label: "Settings", icon: SlidersHorizontal, badge: undefined },
  ] as const;
  const active = faces.reduce<string>((best, f) => {
    const href = desk(f.internal);
    const hit = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
    return hit && href.length >= best.length ? href : best;
  }, "");

  return (
    <DockShell>
      {faces.map((f) => {
        const href = desk(f.internal);
        return (
          <DockItem key={f.internal} href={href} label={f.label} icon={f.icon} active={href === active} badge={f.badge} />
        );
      })}
    </DockShell>
  );
}

function DockShell({ children }: { children: React.ReactNode }) {
  return (
    <nav
      aria-label="Main"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(20px,env(safe-area-inset-bottom))]"
    >
      <div
        className="pointer-events-auto flex items-center gap-1 rounded-[26px] border border-line bg-surface/[0.78] p-1.5
                   shadow-dock backdrop-blur-2xl backdrop-saturate-150"
      >
        {children}
      </div>
    </nav>
  );
}

function DockItem({
  href,
  label,
  icon: Icon,
  active,
  badge,
  onClick,
}: {
  href: string;
  label: string;
  icon: typeof House;
  active: boolean;
  badge?: number;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
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
}
