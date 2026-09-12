"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { adminsExist, isAdmin } from "@/lib/operator";
import { useAuthKey } from "@/hooks/use-auth-key";
import { ensureSession } from "@/lib/supabase/client";

/**
 * Everything under /admin renders behind this. It only decides what to
 * show — every function the pages call checks `is_admin()` itself, so a
 * non-admin who got past the gate would get refusals, not data.
 */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const authKey = useAuthKey();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [clerkId, setClerkId] = useState<string | null>(null);
  const [seatTaken, setSeatTaken] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const session = await ensureSession();
    if (session.status !== "ready") {
      setSignedIn(session.status !== "signed-out");
      setAdmin(false);
      return;
    }
    setClerkId(session.userId);
    setSeatTaken(await adminsExist());
    setAdmin(await isAdmin());
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (admin === null) {
    return (
      <div className="flex items-center gap-2.5 rounded-[20px] border border-line bg-surface p-4 text-[13px] text-muted lg:p-5">
        <Loader2 size={15} className="animate-spin" />
        Checking access…
      </div>
    );
  }

  if (!admin) {
    return (
      <div className="rounded-[20px] border border-clay bg-clay/25 p-5">
        <p className="m-0 flex items-center gap-2 text-[15px] font-semibold">
          <ShieldAlert size={17} strokeWidth={2.2} />
          {signedIn ? "You're not an admin" : "Sign in to continue"}
        </p>
        <p className="m-0 mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed text-ink-soft">
          {!signedIn
            ? "Admins sign in with the same desk account everyone else uses."
            : seatTaken
              ? "Someone else holds admin. Admin is granted only in the Supabase SQL editor, by whoever owns the project — if that row was filled in by mistake, they replace it with this:"
              : "Nobody is an admin yet. Admin is granted only in the Supabase SQL editor, by whoever owns the project — if that's you, run this:"}
        </p>
        {signedIn && clerkId && <AdminFixSql clerkId={clerkId} seatTaken={seatTaken} copied={copied} setCopied={setCopied} />}
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * The repair statement, with the signed-in user's real id already in it.
 *
 * This block previously printed a `<your id>` placeholder, which is exactly how
 * a literal placeholder ends up in the admins table — blocking both the button
 * and access. Never show a fill-in-the-blank for something copied into a SQL
 * editor.
 */
function AdminFixSql({
  clerkId,
  seatTaken,
  copied,
  setCopied,
}: {
  clerkId: string;
  seatTaken: boolean;
  copied: boolean;
  setCopied: (v: boolean) => void;
}) {
  const sql = seatTaken
    ? `-- see who holds it
select * from public.admins;

-- drop any row that isn't a real Clerk id, then take the seat
delete from public.admins where user_id not like 'user\\_%';
insert into public.admins (user_id)
values ('${clerkId}')
on conflict (user_id) do nothing;`
    : `insert into public.admins (user_id)
values ('${clerkId}');`;

  return (
    <div className="relative mt-3">
      <pre className="overflow-x-auto rounded-xl border border-line bg-surface p-3 pr-24 font-mono text-[11px] leading-relaxed">
        {sql}
      </pre>
      <button
        onClick={async () => {
          await navigator.clipboard?.writeText(sql);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        className="absolute top-2 right-2 rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft"
      >
        {copied ? "Copied" : "Copy SQL"}
      </button>
    </div>
  );
}
