"use client";

import { ensureSession, getSupabase } from "./supabase/client";

/**
 * The desk's own tools — everything from migration 0015. Each is a thin call
 * into an RPC or a policy-guarded table; the rules live in Postgres.
 */

/* ---------- messages to the student ---------- */

export interface OrderMessage {
  id: number;
  order_id: string;
  sender: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export async function messagesFor(orderId: string): Promise<OrderMessage[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("order_messages")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  return (data ?? []) as OrderMessage[];
}

export async function sendMessage(orderId: string, body: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const session = await ensureSession();
  if (session.status !== "ready") throw new Error("Sign in first.");

  const text = body.trim();
  if (!text) throw new Error("Write something first.");

  const { error } = await supabase
    .from("order_messages")
    .insert({ order_id: orderId, sender: session.userId, body: text });
  if (error) throw new Error(explain(error.message));
}

/** The student has seen it. Silent on failure — it's a courtesy, not a record. */
export async function markMessagesRead(orderId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase
    .from("order_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .is("read_at", null);
}

/* ---------- stock ledger ---------- */

export interface StockEntry {
  id: number;
  paper_delta: number;
  toner_delta: number;
  note: string | null;
  /** Null when the system wrote it — a job being collected. */
  actor: string | null;
  order_id: string | null;
  created_at: string;
}

export async function stockLog(operatorId: string, limit = 40): Promise<StockEntry[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("stock_log")
    .select("*")
    .eq("operator_id", operatorId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as StockEntry[];
}

export async function adjustStock(
  operatorId: string,
  delta: { paper?: number; toner?: number },
  note: string,
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("adjust_stock", {
    p_operator: operatorId,
    p_paper: delta.paper ?? 0,
    p_toner: delta.toner ?? 0,
    p_note: note.trim() || null,
  });
  if (error) throw new Error(explain(error.message));
}

/* ---------- staff ---------- */

export interface StaffMember {
  user_id: string;
  name: string | null;
  email: string | null;
  joined_at: string;
  /** Whether they can start a shift from a paired device. */
  has_pin: boolean;
}

export async function listStaff(operatorId: string): Promise<StaffMember[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.rpc("list_staff", { p_operator: operatorId });
  return (data ?? []) as StaffMember[];
}

export async function addStaff(operatorId: string, email: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("add_staff", {
    p_operator: operatorId,
    p_email: email.trim(),
  });
  if (error) throw new Error(explain(error.message));
}

export async function removeStaff(operatorId: string, userId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("remove_staff", {
    p_operator: operatorId,
    p_user: userId,
  });
  if (error) throw new Error(explain(error.message));
}

/* ---------- close-out ---------- */

export interface Closeout {
  id: number;
  day: string;
  expected_cash: number | string;
  counted_cash: number | string | null;
  upi_total: number | string;
  orders: number;
  uncollected: number;
  note: string | null;
  actor: string;
  created_at: string;
}

export async function closeDesk(
  operatorId: string,
  countedCash: number | null,
  note: string,
): Promise<Closeout> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { data, error } = await supabase.rpc("close_desk", {
    p_operator: operatorId,
    p_counted_cash: countedCash,
    p_note: note.trim() || null,
  });
  if (error) throw new Error(explain(error.message));
  return data as Closeout;
}

export async function recentCloseouts(operatorId: string, limit = 7): Promise<Closeout[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("desk_closeouts")
    .select("*")
    .eq("operator_id", operatorId)
    .order("day", { ascending: false })
    .limit(limit);
  return (data ?? []) as Closeout[];
}

function explain(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("does not exist") || m.includes("schema cache")) {
    return "This needs migration 0015 — run supabase/migrations/0015_desk_tools.sql.";
  }
  if (m.includes("row-level security")) {
    return "The database refused that. Your sign-in may not be reaching Supabase.";
  }
  return message;
}
