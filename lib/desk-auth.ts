"use client";

import { getSupabase } from "./supabase/client";

/**
 * A paired desk device, and the shift that starts with a PIN.
 *
 * The device token lives in localStorage on the desk's own phone or tablet.
 * It is the one secret this file handles; a copy of it makes a device
 * "paired" until the desk revokes it from Settings. The PIN is never stored
 * anywhere on the device.
 */

const TOKEN_KEY = "printify.desk.token";

export function deviceToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    return t && /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

export function isPairedDevice(): boolean {
  return deviceToken() !== null;
}

/** Pairs this browser to a desk. Needs a signed-in staff member. */
export async function pairThisDevice(operatorId: string, name: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { data, error } = await supabase.rpc("pair_device", {
    p_operator: operatorId,
    p_name: name.trim(),
  });
  if (error) throw new Error(explain(error.message));
  const token = data as string;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    throw new Error("This browser won't keep the pairing — private mode, or storage is blocked.");
  }
}

/** Forgets the pairing on this browser. The desk still lists it until revoked. */
export function forgetThisDevice(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to forget */
  }
}

export interface DeskDevice {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export async function listDevices(operatorId: string): Promise<DeskDevice[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("desk_devices")
    .select("id, name, created_by, created_at, last_seen_at, revoked_at")
    .eq("operator_id", operatorId)
    .order("created_at", { ascending: false });
  return (data ?? []) as DeskDevice[];
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("revoke_device", { p_device: deviceId });
  if (error) throw new Error(explain(error.message));
}

/** Sets the signed-in staff member's own PIN for a desk. */
export async function setMyPin(operatorId: string, pin: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("set_my_pin", { p_operator: operatorId, p_pin: pin });
  if (error) throw new Error(explain(error.message));
}

export interface DeskStaff {
  operator_id: string;
  operator_name: string;
  user_id: string;
  name: string;
  has_pin: boolean;
}

/** The names on the tap-a-name screen. Works signed out; the token is the credential. */
export async function deskStaff(token: string): Promise<DeskStaff[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("desk_staff", { p_token: token });
  if (error) throw new Error(explain(error.message));
  return (data ?? []) as DeskStaff[];
}

/**
 * Asks the server to check the PIN and mint a Clerk ticket. The caller
 * redeems the ticket with Clerk's `signIn.create({ strategy: "ticket" })`.
 */
export async function deskTicket(token: string, userId: string, pin: string): Promise<string> {
  const res = await fetch("/api/desk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, userId, pin }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; ticket?: string; message?: string };
  if (!res.ok || !body.ok || !body.ticket) {
    throw new Error(body.message ?? "Sign-in refused.");
  }
  return body.ticket;
}

function explain(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("does not exist") || m.includes("schema cache")) {
    return "Desk sign-in needs migration 0018 — run supabase/migrations/0018_desk_devices.sql.";
  }
  return message;
}
