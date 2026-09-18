"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);
export const isClerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

/** Bucket holding uploaded documents. Private — reads go through signed URLs. */
export const DOCUMENTS_BUCKET = "documents";

/**
 * Clerk owns the session; Supabase just verifies its JWT.
 *
 * These are registered by <SupabaseBridge> once Clerk has loaded, so modules
 * outside React can still reach the current token without importing hooks.
 */
type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter | null = null;
let currentUserId: string | null = null;
let clerkLoaded = false;

export function registerClerkBridge(params: {
  getToken: TokenGetter;
  userId: string | null;
  loaded: boolean;
}) {
  getToken = params.getToken;
  currentUserId = params.userId;
  clerkLoaded = params.loaded;
}

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;

  cached ??= createClient(SUPABASE_URL, SUPABASE_KEY, {
    // Supabase calls this before every request (and on realtime connect), so a
    // rotated Clerk token is picked up without rebuilding the client.
    accessToken: async () => (getToken ? await getToken() : null),
    realtime: {
      // The default of 10/s is a client-side throttle. A busy counter can move
      // several orders in the same second, and a dropped frame there is a
      // status the student never sees.
      params: { eventsPerSecond: 40 },
      // The operator's tab is usually in the background — they're at the
      // machine. Browsers throttle a background tab's timers to once a minute,
      // which is longer than a Clerk token lives, so a main-thread heartbeat
      // silently stops refreshing it and the socket drops. A Web Worker's
      // timers aren't throttled. Built from an inline blob, which the CSP's
      // `worker-src blob:` allows.
      worker: true,
      // Under the thirty seconds of token leeway the bridge asks Clerk for.
      heartbeatIntervalMs: 20_000,
    },
  });

  return cached;
}

/** Who the data layer thinks is asking, as one string — the key the hooks re-run on. */
export function sessionKey(): string {
  return `${clerkLoaded ? "loaded" : "loading"}:${currentUserId ?? "anon"}`;
}

let publicClient: SupabaseClient | null = null;

/**
 * The same project, asked as nobody.
 *
 * The client above hands Clerk's token to every request, and Clerk's
 * `getToken()` resolves only once clerk-js has loaded and asked Clerk who
 * this is — on a phone, the better part of three seconds after the page is
 * on screen. Rows the world may read (the listed desks, the platform's
 * settings, a desk's wait) sat behind that wait for no reason: the prices
 * and "no queue right now" landed at 3.5 s on a page that painted at 0.6 s.
 * Reads of those go through here and start the moment the page hydrates.
 * Nothing that depends on who's asking ever does — this client has no token
 * to give, so RLS would hand it nothing, silently.
 */
export function getPublicSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  publicClient ??= createClient(SUPABASE_URL, SUPABASE_KEY, {
    // Its own storage key, and nothing kept: the two clients must not
    // share (or warn about sharing) a session slot in localStorage.
    auth: { storageKey: "printify-public", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return publicClient;
}

export type SessionState =
  | { status: "ready"; userId: string; accessToken: string }
  | { status: "signed-out" }
  | { status: "loading" }
  | { status: "unconfigured"; message: string }
  | { status: "error"; message: string };

/**
 * What the data layer needs before it can talk to Postgres: a Clerk user id and
 * a token Supabase will accept. Nothing is created implicitly — if nobody is
 * signed in, that's a real state the UI has to show, not something to paper over.
 */
export async function ensureSession(): Promise<SessionState> {
  if (!isSupabaseConfigured) {
    return { status: "unconfigured", message: "No Supabase project configured." };
  }
  if (!isClerkConfigured) {
    return { status: "unconfigured", message: "No Clerk publishable key configured." };
  }
  if (!clerkLoaded) return { status: "loading" };
  if (!currentUserId || !getToken) return { status: "signed-out" };

  try {
    const token = await getToken();
    if (!token) return { status: "signed-out" };
    return { status: "ready", userId: currentUserId, accessToken: token };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Couldn't get a session token.",
    };
  }
}

export interface ClerkIdentity {
  userId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  avatarUrl: string | null;
}

/**
 * Mirrors the Clerk identity into `profiles`.
 *
 * Clerk can't write to Postgres, so this runs on every authenticated load
 * rather than from a trigger — `auth.users` isn't in play any more. Identity
 * columns are overwritten each time so a changed email or avatar syncs, while
 * the fields a student fills in themselves (roll number, hostel, phone) are
 * never touched here.
 *
 * The error is returned, not swallowed: if Clerk's Supabase integration is off,
 * the token carries no `authenticated` role, RLS rejects the insert, and the
 * row silently never appears — which looks exactly like "the app is broken".
 */
export async function syncProfile(identity: ClerkIdentity): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return "No Supabase project configured.";

  const { error } = await supabase.from("profiles").upsert(
    {
      id: identity.userId,
      email: identity.email,
      first_name: identity.firstName,
      last_name: identity.lastName,
      name: identity.fullName ?? identity.firstName ?? identity.email,
      avatar_url: identity.avatarUrl,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  if (!error) return null;

  if (error.message.includes("does not exist") || error.message.includes("schema cache")) {
    return "The profiles table is missing a column. Run supabase/migrations/0002_profiles_and_pages.sql.";
  }
  if (error.message.toLowerCase().includes("row-level security")) {
    return "Postgres rejected the write. Enable the Supabase integration in Clerk (Configure → Integrations) so its token carries the authenticated role.";
  }
  return error.message;
}

export interface WhoAmI {
  clerk_sub: string | null;
  pg_role: string;
  jwt_role: string;
  has_profile: boolean;
}

/** What Postgres thinks the caller is. Powers the diagnostics on /profile. */
export async function whoami(): Promise<WhoAmI | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.rpc("whoami");
  return (data?.[0] as WhoAmI) ?? null;
}
