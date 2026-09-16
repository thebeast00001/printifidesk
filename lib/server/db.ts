import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { auth } from "@clerk/nextjs/server";
import { sameOriginRequest } from "./surface";

/**
 * The server's own connection: the service role, which RLS doesn't bind.
 * Every route that uses it decides for itself who the caller is, with the
 * helpers below, before touching anything — the key is capability, not
 * permission.
 */
export function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The signed-in Clerk user, or null. */
export async function callerId(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

export async function isAdminUser(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await supabase.from("admins").select("user_id").eq("user_id", userId).maybeSingle();
  return Boolean(data);
}

export async function isStaffOf(supabase: SupabaseClient, userId: string, operatorId: string): Promise<boolean> {
  const { data } = await supabase
    .from("staff")
    .select("user_id")
    .eq("user_id", userId)
    .eq("operator_id", operatorId)
    .maybeSingle();
  return Boolean(data);
}

/** 0039: the desk's owner — rates, payments, refunds and takings are theirs. */
export async function isOwnerOf(supabase: SupabaseClient, userId: string, operatorId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("staff")
    .select("role")
    .eq("user_id", userId)
    .eq("operator_id", operatorId)
    .maybeSingle();
  // Before 0039 there is no role column and every member is an owner.
  if (error?.code === "42703") return isStaffOf(supabase, userId, operatorId);
  return (data as { role?: string } | null)?.role === "owner";
}

/** A JSON error the client can show. */
export function fail(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * For a route that changes something on the strength of the session
 * cookie: the request must come from a page of ours. The cookie is
 * SameSite=Lax, which already keeps it off cross-site POSTs in every
 * current browser; this is the same rule stated a second time, in the
 * route, where it can't be undone by a cookie setting elsewhere.
 */
export async function refuseCrossOrigin(request: Request): Promise<Response | null> {
  return (await sameOriginRequest(request)) ? null : fail("This request didn't come from Printify.", 403);
}
