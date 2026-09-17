"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import {
  Camera,
  ChevronRight,
  KeyRound,
  Loader2,
  LogOut,
  Printer,
  Receipt,
  Settings2,
  Upload,
  Wallet,
} from "lucide-react";
import { Figure } from "./figure";
import { SettingsGroup } from "./settings-ui";
import { InstallRow } from "./install-app";
import { useTotals } from "@/hooks/use-tracking";
import { useAuthKey } from "@/hooks/use-auth-key";
import { ensureSession, getSupabase } from "@/lib/supabase/client";
import { listDocuments, type DocumentRow } from "@/lib/upload";
import { cashStanding, type CashStanding } from "@/lib/orders";
import { formatBytes } from "@/lib/analysis";
import { useApp } from "@/lib/store";

interface Profile {
  name: string | null;
  email: string | null;
  roll_no: string | null;
  department: string | null;
  hostel: string | null;
  room: string | null;
}

export function ProfileView() {
  const authKey = useAuthKey();
  const { totals, ready } = useTotals();
  const { user } = useUser();
  const clerk = useClerk();
  const openSheet = useApp((s) => s.openSheet);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  // 0043: the cash limit they've earned, and anything owed.
  const [standing, setStanding] = useState<CashStanding | null>(null);

  const load = useCallback(async () => {
    const state = await ensureSession();

    if (state.status !== "ready") {
      setDocs([]);
      return;
    }

    const supabase = getSupabase();
    const [{ data: row }, documents] = await Promise.all([
      supabase!
        .from("profiles")
        .select("name, email, roll_no, department, hostel, room")
        .maybeSingle(),
      listDocuments(),
    ]);

    setProfile((row as Profile) ?? null);
    setDocs(documents);
    setStanding(await cashStanding());
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const email = user?.primaryEmailAddress?.emailAddress ?? profile?.email ?? null;
  const displayName = user?.fullName?.trim() || profile?.name?.trim() || email || "Your account";
  const initials =
    displayName
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "—";


  return (
    <div className="flex max-w-[720px] flex-col gap-7">
      {/* The avatar opens Clerk's own editor — image, email, password all live there. */}
      <section data-anim="identity" className="flex items-center gap-4">
        <button
          onClick={() => clerk.openUserProfile()}
          className="group relative size-16 shrink-0 overflow-hidden rounded-full bg-bone lg:size-20"
          aria-label="Change your profile photo"
        >
          {user?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.imageUrl} alt="" className="size-full object-cover" />
          ) : (
            <span className="font-figure grid size-full place-items-center text-[22px] font-extrabold text-ink lg:text-[26px]">
              {initials}
            </span>
          )}
          <span className="absolute inset-0 grid place-items-center bg-ink/60 text-paper opacity-0 transition-opacity group-hover:opacity-100">
            <Camera size={18} strokeWidth={2} />
          </span>
        </button>

        <div className="min-w-0">
          <h2 className="font-heading m-0 text-[22px] font-bold lg:text-[26px]">{displayName}</h2>
          {email && <p className="m-0 mt-1 truncate font-mono text-[12px] text-muted">{email}</p>}
          <p className="m-0 mt-0.5 font-mono text-[12px] text-muted">
            {[profile?.roll_no, profile?.department].filter(Boolean).join(" · ") ||
              "Add your details in Settings"}
          </p>
        </div>
      </section>

      <section data-anim="stats" className="grid grid-cols-3 gap-3">
        <Stat icon={Printer} value={totals?.pages ?? 0} label="pages printed" loading={!ready} />
        <Stat icon={Receipt} value={totals?.orders ?? 0} label="orders" loading={!ready} />
        <Stat
          icon={Wallet}
          value={Math.round(Number(totals?.spent ?? 0))}
          label="billed"
          prefix="₹"
          loading={!ready}
        />
      </section>

      <SettingsGroup title="Account">
        <ActionRow
          icon={KeyRound}
          label="Manage account"
          hint="Photo, email, password, connected logins, security"
          onClick={() => clerk.openUserProfile()}
        />
        <NavRow
          href="/settings"
          icon={Settings2}
          label="Details and preferences"
          hint="Roll number, hostel, default print settings"
        />
        <InstallRow />
      </SettingsGroup>

      <SettingsGroup title="Printing">
        <ActionRow
          icon={Upload}
          label="New print job"
          hint="Upload files and review pages"
          onClick={() => openSheet("upload")}
        />
        <NavRow href="/orders" icon={Receipt} label="Your orders" hint="Tokens and live status" />
        {standing && (
          <div className="flex items-center gap-3.5 px-4 py-3.5 lg:px-5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunk text-ink-soft">
              <Wallet size={16} strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 text-[14px] font-semibold tracking-[-0.01em]">
                {standing.dues > 0 ? `₹${standing.dues.toFixed(0)} due` : `Cash limit ₹${standing.cash_limit.toFixed(0)}`}
              </p>
              <p className="m-0 mt-0.5 text-[12px] text-muted">
                {standing.dues > 0
                  ? "From an uncollected cash order — pay it on the home page to order again"
                  : standing.blocked_until && new Date(standing.blocked_until) > new Date()
                    ? `Cash is off until ${new Date(standing.blocked_until).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} — UPI works as usual`
                    : `Per cash order, paid when you collect · grows each time you collect (${standing.collected} so far)`}
              </p>
            </div>
          </div>
        )}
        {/* Nothing here points at the desk or the admin's tools: those are
            the desk site's, reached by its own address, and a student's
            profile is a student's. */}
      </SettingsGroup>

      <SettingsGroup
        title="Stored documents"
        note="Only you can read these. Delete them any time from Settings."
      >
        {docs === null ? (
          <div className="flex items-center gap-2.5 p-4 text-[13px] text-muted lg:px-5">
            <Loader2 size={14} className="animate-spin" />
            Checking your files…
          </div>
        ) : docs.length === 0 ? (
          <div className="p-4 text-[13px] text-muted lg:px-5">
            No documents stored yet. Anything you upload appears here.
          </div>
        ) : (
          docs.slice(0, 6).map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 p-4 lg:px-5">
              <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line bg-surface-sunk font-mono text-[9px] text-muted">
                {doc.kind}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em]">
                  {doc.name}
                </span>
                <span className="mt-0.5 block font-mono text-[11px] text-muted">
                  {doc.pages} p · {doc.colour_pages} colour · {formatBytes(doc.size_bytes ?? 0)}
                </span>
              </span>
            </div>
          ))
        )}
      </SettingsGroup>

      <p className="m-0 text-[11.5px] text-muted">
        <Link href="/privacy" className="underline-offset-2 hover:underline">Privacy policy</Link>
        {" · "}
        <Link href="/terms" className="underline-offset-2 hover:underline">Terms of service</Link>
      </p>

      <button
        onClick={() => clerk.signOut()}
        className="flex items-center gap-2 self-start rounded-full border border-line bg-surface px-5 py-2.5 text-[13px] font-semibold text-ink-soft shadow-card transition-colors hover:bg-surface-sunk"
      >
        <LogOut size={14} strokeWidth={2.2} />
        Sign out
      </button>
    </div>
  );
}

type IconType = React.ComponentType<{ size?: number; strokeWidth?: number }>;

function RowInner({ icon: Icon, label, hint }: { icon: IconType; label: string; hint?: string }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line bg-surface-sunk">
          <Icon size={15} strokeWidth={2} />
        </span>
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold tracking-[-0.01em]">{label}</span>
          {hint && <span className="mt-0.5 block truncate text-[11.5px] text-muted">{hint}</span>}
        </span>
      </span>
      <ChevronRight size={16} strokeWidth={2} className="shrink-0 text-faint" />
    </>
  );
}

function NavRow({ href, ...rest }: { href: string; icon: IconType; label: string; hint?: string }) {
  return (
    <Link
      href={href}
      className="flex w-full items-center justify-between gap-6 p-4 text-left transition-colors hover:bg-surface-sunk lg:px-5"
    >
      <RowInner {...rest} />
    </Link>
  );
}

function ActionRow({
  onClick,
  ...rest
}: {
  onClick: () => void;
  icon: IconType;
  label: string;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between gap-6 p-4 text-left transition-colors hover:bg-surface-sunk lg:px-5"
    >
      <RowInner {...rest} />
    </button>
  );
}

function Stat({
  icon: Icon,
  value,
  label,
  prefix,
  loading,
}: {
  icon: IconType;
  value: number;
  label: string;
  prefix?: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-[18px] border border-line bg-surface p-3.5 shadow-card lg:p-4">
      <Icon size={15} strokeWidth={2} />
      {loading ? (
        <p className="font-figure m-0 mt-2 text-[24px] font-extrabold text-faint">—</p>
      ) : (
        <Figure
          value={value}
          prefix={prefix ?? ""}
          className="mt-2 !justify-start text-[24px] font-extrabold"
        />
      )}
      <p className="m-0 mt-0.5 text-[11.5px] leading-snug text-muted">{label}</p>
    </div>
  );
}

