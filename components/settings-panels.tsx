"use client";

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { motion } from "motion/react";
import { AlertCircle, Bell, Check, Loader2, Monitor, Moon, Sun, Trash2, X } from "lucide-react";
import { ClientOnly, Segmented, SettingsGroup, SettingsRow } from "./settings-ui";
import { useAuthKey } from "@/hooks/use-auth-key";
import { ensureSession, getSupabase } from "@/lib/supabase/client";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/push";
import { deleteDocument, listDocuments, type DocumentRow } from "@/lib/upload";
import { cn, spring } from "@/lib/utils";

type ThemeChoice = "light" | "dark" | "system";

const THEME_OPTIONS = [
  { value: "light" as const, label: "Light", icon: Sun },
  { value: "dark" as const, label: "Dark", icon: Moon },
  { value: "system" as const, label: "System", icon: Monitor },
];

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <SettingsGroup
      title="Appearance"
      note="System follows whatever your phone or laptop is set to, including the automatic switch at sunset."
    >
      <SettingsRow
        label="Theme"
        description="Applies everywhere and is remembered on this device."
        control={
          <ClientOnly>
            <Segmented
              id="theme"
              value={(theme as ThemeChoice) ?? "system"}
              options={THEME_OPTIONS}
              onChange={setTheme}
            />
          </ClientOnly>
        }
      />
    </SettingsGroup>
  );
}

interface ProfileRow {
  name: string | null;
  email: string | null;
  phone: string | null;
  roll_no: string | null;
  department: string | null;
  year: string | null;
  hostel: string | null;
  room: string | null;
}

const FIELDS: { key: keyof ProfileRow; label: string; placeholder: string }[] = [
  { key: "name", label: "Name", placeholder: "Your name" },
  { key: "roll_no", label: "Roll number", placeholder: "e.g. 21CS1049" },
  { key: "department", label: "Department", placeholder: "e.g. Computer Science" },
  { key: "year", label: "Year / semester", placeholder: "e.g. Semester 5" },
  { key: "hostel", label: "Hostel", placeholder: "e.g. Ganga Hostel" },
  { key: "room", label: "Room", placeholder: "e.g. 214" },
  { key: "phone", label: "Phone", placeholder: "For pickup reminders" },
];

const PROFILE_COLUMNS = "name, email, phone, roll_no, department, year, hostel, room";

/** Returns the row, or a message explaining why it couldn't be read. */
async function readProfile(userId: string): Promise<ProfileRow | null | string> {
  const supabase = getSupabase();
  if (!supabase) return "No Supabase project configured.";

  // Filtered explicitly rather than relying on RLS to leave exactly one row —
  // `maybeSingle()` throws if a policy ever widens.
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", userId)
    .maybeSingle();

  if (error) return explainWrite(error.message);
  return (data as ProfileRow) ?? null;
}

function explainWrite(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("row-level security")) {
    return "Postgres refused the write. Enable the Supabase integration in Clerk (Configure → Integrations) so its token carries the authenticated role.";
  }
  if (m.includes("does not exist") || m.includes("schema cache")) {
    return "A column is missing. Run the migrations in supabase/migrations, in order.";
  }
  return message;
}

/** Reads and writes the real `profiles` row. Blank fields say so. */
export function AccountSettings() {
  const authKey = useAuthKey();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<keyof ProfileRow | null>(null);

  const load = useCallback(async () => {
    const session = await ensureSession();
    if (session.status !== "ready") {
      // Each state has its own cause; a blanket "not configured" sent people
      // hunting for a problem that wasn't there.
      setError(
        session.status === "signed-out"
          ? "Sign in to see and save your details."
          : session.status === "loading"
            ? null
            : session.message,
      );
      setLoading(false);
      return;
    }
    const row = await readProfile(session.userId);
    if (typeof row === "string") setError(row);
    else {
      setError(null);
      setProfile(row);
    }
    setLoading(false);
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Writes, then reads the row back and shows whatever the database actually
   * holds — never the value that was typed.
   *
   * A write can affect zero rows without raising: RLS can filter the update
   * out, or the row can be missing. Trusting local state made those look like a
   * successful save that reverted on the next load, which is exactly the bug
   * this replaces.
   */
  async function save(key: keyof ProfileRow, value: string) {
    const session = await ensureSession();
    if (session.status !== "ready") {
      setError("Sign in to save your details.");
      return;
    }

    const wanted = value.trim() || null;
    const supabase = getSupabase();

    // Upsert, not update: a first-time user may have no row yet if the identity
    // sync hasn't landed, and an update would then silently affect zero rows.
    const { error: writeError } = await supabase!
      .from("profiles")
      .upsert({ id: session.userId, [key]: wanted }, { onConflict: "id" });

    if (writeError) {
      setError(explainWrite(writeError.message));
      return;
    }

    const row = await readProfile(session.userId);
    if (typeof row === "string") {
      setError(row);
      return;
    }

    setProfile(row);

    if ((row?.[key] ?? null) !== wanted) {
      setError(
        "That didn't stick — the database still has the old value. Check /diagnostics: if the JWT role isn't `authenticated`, RLS is silently dropping the write.",
      );
      return;
    }

    setError(null);
    setSaved(key);
    setTimeout(() => setSaved((k) => (k === key ? null : k)), 1800);
  }

  return (
    <SettingsGroup
      title="Account"
      note={
        error
          ? undefined
          : "Written straight to the profiles table in Supabase — not just this browser."
      }
    >
      {error && (
        <p className="m-0 flex items-start gap-2.5 bg-clay px-4 py-3 text-[12.5px] leading-relaxed text-clay-ink lg:px-5">
          <AlertCircle size={15} strokeWidth={2.2} className="mt-px shrink-0" />
          {error}
        </p>
      )}
      {loading ? (
        <div className="flex items-center gap-2.5 p-4 text-[13px] text-muted lg:px-5">
          <Loader2 size={14} className="animate-spin" />
          Loading your details…
        </div>
      ) : (
        FIELDS.map((field) => (
          <EditableRow
            key={field.key}
            label={field.label}
            placeholder={field.placeholder}
            value={profile?.[field.key] ?? ""}
            saved={saved === field.key}
            onSave={(v) => save(field.key, v)}
          />
        ))
      )}
    </SettingsGroup>
  );
}

function EditableRow({
  label,
  value,
  placeholder,
  saved,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  saved?: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(value), [value]);

  async function commit() {
    setSaving(true);
    await onSave(draft.trim());
    setSaving(false);
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex w-full items-center justify-between gap-6 p-4 text-left transition-colors hover:bg-surface-sunk lg:px-5"
      >
        <span className="text-[14px] font-semibold tracking-[-0.01em]">{label}</span>
        <span className="flex min-w-0 items-center gap-2">
          {saved && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-sage px-2 py-0.5 text-[10.5px] font-semibold text-sage-ink">
              <Check size={10} strokeWidth={3} />
              Saved
            </span>
          )}
          <span className={cn("truncate text-[13px]", value ? "text-muted" : "text-faint")}>
            {value || "Not set"}
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 p-4 lg:px-5">
      <span className="w-28 shrink-0 text-[14px] font-semibold tracking-[-0.01em]">{label}</span>
      <input
        autoFocus
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 text-[13px] outline-none focus:border-ink"
      />
      <motion.button
        whileTap={{ scale: 0.9 }}
        transition={spring}
        onClick={commit}
        disabled={saving}
        aria-label="Save"
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-ink text-paper"
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} strokeWidth={2.4} />}
      </motion.button>
      <button
        onClick={() => setEditing(false)}
        aria-label="Cancel"
        className="grid size-8 shrink-0 place-items-center rounded-lg border border-line text-muted"
      >
        <X size={14} strokeWidth={2.2} />
      </button>
    </div>
  );
}

/** Deletes for real — storage objects first, then the rows. */
export function PrivacySettings() {
  const authKey = useAuthKey();
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const session = await ensureSession();
    if (session.status !== "ready") return setDocs([]);
    setDocs(await listDocuments());
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  async function deleteAll() {
    if (!docs?.length) return;
    setBusy(true);
    for (const doc of docs) await deleteDocument(doc.id, doc.storage_path);
    await load();
    setBusy(false);
    setConfirming(false);
  }

  const count = docs?.length ?? 0;

  return (
    <SettingsGroup
      title="Privacy"
      note="Operators can send a file to the printer but never download it. Deleting removes the stored copy immediately."
    >
      <SettingsRow
        label="Delete stored files"
        description={
          docs === null
            ? "Checking…"
            : count === 0
              ? "Nothing stored right now."
              : `Removes all ${count} stored ${count === 1 ? "document" : "documents"}. Orders already printing are unaffected.`
        }
        control={
          confirming ? (
            <div className="flex gap-2">
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={deleteAll}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-full bg-clay px-4 py-2.5 text-[12.5px] font-semibold text-clay-ink disabled:opacity-60"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} strokeWidth={2.2} />}
                Confirm
              </motion.button>
              <button
                onClick={() => setConfirming(false)}
                className="rounded-full border border-line px-4 py-2.5 text-[12.5px] font-semibold text-muted"
              >
                Keep
              </button>
            </div>
          ) : (
            <motion.button
              whileTap={{ scale: 0.95 }}
              disabled={count === 0}
              onClick={() => setConfirming(true)}
              className="flex items-center gap-2 rounded-full border border-line bg-surface-sunk px-4 py-2.5 text-[12.5px] font-semibold text-ink-soft disabled:opacity-50"
            >
              <Trash2 size={13} strokeWidth={2.2} />
              Delete files
            </motion.button>
          )
        }
      />
    </SettingsGroup>
  );
}

/**
 * WhatsApp updates.
 *
 * The toggle only controls whether messages are *queued* — delivery depends on
 * the server having WhatsApp credentials, so the panel reports what actually
 * happened to recent messages rather than assuming they arrived.
 */
export function NotificationSettings() {
  const authKey = useAuthKey();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [recent, setRecent] = useState<NotificationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const session = await ensureSession();
    if (session.status !== "ready") {
      setEnabled(null);
      setRecent([]);
      return;
    }
    const supabase = getSupabase();
    const [{ data: profile }, { data: log }] = await Promise.all([
      supabase!
        .from("profiles")
        .select("notify_whatsapp, phone")
        .eq("id", session.userId)
        .maybeSingle(),
      supabase!
        .from("notifications")
        .select("id, status, detail, body, created_at")
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

    const row = profile as { notify_whatsapp?: boolean; phone?: string | null } | null;
    setEnabled(row?.notify_whatsapp ?? true);
    setPhone(row?.phone ?? null);
    setRecent((log ?? []) as NotificationRow[]);
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(next: boolean) {
    const session = await ensureSession();
    if (session.status !== "ready") return;

    const supabase = getSupabase();
    const { error: writeError } = await supabase!
      .from("profiles")
      .upsert({ id: session.userId, notify_whatsapp: next }, { onConflict: "id" });

    if (writeError) {
      setError(explainWrite(writeError.message));
      return;
    }
    setError(null);
    await load();
  }

  return (
    <SettingsGroup
      title="Updates"
      note={
        error ??
        (phone
          ? `Messages go to ${phone}. Change it under Account.`
          : "Add a phone number under Account to receive these.")
      }
    >
      <PushRow />

      <SettingsRow
        label="WhatsApp updates"
        description="When your job joins the queue, is ready, or can't be printed."
        control={
          enabled === null ? (
            <span className="text-[12.5px] text-muted">—</span>
          ) : (
            <Segmented
              id="notify"
              value={enabled ? "on" : "off"}
              options={[
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
              onChange={(v) => toggle(v === "on")}
            />
          )
        }
      />

      {recent && recent.length > 0 && (
        <div className="p-4 lg:px-5">
          <p className="label-caps m-0 mb-2">Recent messages</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {recent.map((n) => (
              <li key={n.id} className="flex items-start gap-2.5">
                <span
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    n.status === "sent"
                      ? "bg-sage"
                      : n.status === "failed"
                        ? "bg-clay"
                        : "bg-line-strong",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{n.body}</span>
                  <span className="mt-0.5 block font-mono text-[10.5px] text-muted">
                    {n.status}
                    {n.detail && n.status !== "sent" ? ` · ${n.detail}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingsGroup>
  );
}

interface NotificationRow {
  id: number;
  status: string;
  detail: string | null;
  body: string;
  created_at: string;
}

/**
 * Browser notifications.
 *
 * The only channel that reaches somebody who closed the tab without needing a
 * provider account or a phone number, so it's offered first. Each state says
 * what it is rather than showing a toggle that silently does nothing —
 * a blocked permission can only be undone in browser settings.
 */
function PushRow() {
  const authKey = useAuthKey();
  const [state, setState] = useState<PushState>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState(await pushState());
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const description: Record<PushState, string> = {
    checking: "Checking…",
    unsupported: "This browser can't do notifications. Try Chrome, Edge or Firefox.",
    unconfigured: "Not set up on the server — NEXT_PUBLIC_VAPID_PUBLIC_KEY is missing.",
    denied: "Blocked. Allow notifications for this site in your browser settings, then reload.",
    off: "Get a notification the moment your job is ready, even with the tab closed.",
    on: "On for this device. Sign in on your phone to add that one too.",
  };

  return (
    <SettingsRow
      label="Notifications"
      description={error ?? description[state]}
      control={
        state === "checking" ? (
          <Loader2 size={14} className="animate-spin text-muted" />
        ) : state === "unsupported" || state === "unconfigured" || state === "denied" ? (
          <span className="rounded-full bg-surface-sunk px-3 py-1.5 text-[11.5px] font-semibold text-muted">
            Unavailable
          </span>
        ) : (
          <motion.button
            whileTap={{ scale: 0.95 }}
            transition={spring}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setState(state === "on" ? await disablePush() : await enablePush());
              } catch (e) {
                setError(e instanceof Error ? e.message : "Couldn't change that.");
              } finally {
                setBusy(false);
              }
            }}
            className={cn(
              "flex items-center gap-2 rounded-full px-4 py-2.5 text-[12.5px] font-semibold",
              state === "on" ? "border border-line bg-surface text-ink-soft" : "bg-ink text-paper",
            )}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Bell size={13} strokeWidth={2.2} />}
            {state === "on" ? "Turn off" : "Turn on"}
          </motion.button>
        )
      }
    />
  );
}
