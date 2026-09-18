"use client";

import { ensureSession, getSupabase } from "./supabase/client";
import { changed } from "./changed";
import { pokeDispatch } from "./push";

/**
 * Delivery to the door (0046): the runner's side and the admin's, as thin
 * clients over the functions in the database. Nothing here decides who may
 * do what — `is_runner()` and `is_admin()` do, inside each function.
 */

/** Where an account stands with delivery: not asked, waiting, granted, or removed. */
export type RunnerStatus = "none" | "requested" | "active" | "removed";

/**
 * The caller's own runner row, through RLS. A project without 0046 has no
 * table; that reads as "none", and the desk app shows what it always did.
 */
export async function myRunnerStatus(): Promise<RunnerStatus> {
  const supabase = getSupabase();
  if (!supabase) return "none";
  const session = await ensureSession();
  if (session.status !== "ready") return "none";
  const { data, error } = await supabase.from("runners").select("status").eq("user_id", session.userId).maybeSingle();
  if (error || !data) return "none";
  const s = (data as { status?: string }).status;
  return s === "active" || s === "requested" || s === "removed" ? s : "none";
}

/** Asking to deliver for Printifi. Nothing opens until the admin approves it. */
export async function requestRunner(phone: string): Promise<RunnerStatus> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { data, error } = await supabase.rpc("request_runner", { p_phone: phone.trim() || null });
  if (error) throw new Error(explain(error.message));
  pokeDispatch();
  return data === "active" ? "active" : "requested";
}

/** One delivery job as the runner sees it: who, where, what's owed. Never the handover secret. */
export interface RunnerJob {
  id: string;
  token: string | null;
  status: "ready" | "delivering" | "collected";
  operator_id: string;
  desk: string;
  campus: string | null;
  student: string | null;
  phone: string | null;
  hostel: string | null;
  room: string | null;
  pages: number;
  total: number;
  /** What the runner takes in cash at the door; zero when the bill is already paid. */
  cash_due: number;
  delivery_fee: number;
  ready_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  returned_at: string | null;
  delivery_returns: number;
  runner_id: string | null;
  /** In this runner's hands. */
  mine: boolean;
  shelf_slot: string | null;
  note: string | null;
  delivery_proof: "scan" | "runner" | null;
}

const num = (v: unknown) => Number(v ?? 0);

export async function runnerOrders(): Promise<RunnerJob[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("runner_orders");
  if (error) throw new Error(explain(error.message));
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    token: (r.token as string | null) ?? null,
    status: (r.status as RunnerJob["status"]) ?? "ready",
    operator_id: String(r.operator_id),
    desk: String(r.desk ?? ""),
    campus: (r.campus as string | null) ?? null,
    student: (r.student as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    hostel: (r.hostel as string | null) ?? null,
    room: (r.room as string | null) ?? null,
    pages: num(r.pages),
    total: num(r.total),
    cash_due: num(r.cash_due),
    delivery_fee: num(r.delivery_fee),
    ready_at: (r.ready_at as string | null) ?? null,
    picked_up_at: (r.picked_up_at as string | null) ?? null,
    delivered_at: (r.delivered_at as string | null) ?? null,
    returned_at: (r.returned_at as string | null) ?? null,
    delivery_returns: num(r.delivery_returns),
    runner_id: (r.runner_id as string | null) ?? null,
    mine: r.mine === true,
    shelf_slot: (r.shelf_slot as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    delivery_proof: (r.delivery_proof as RunnerJob["delivery_proof"]) ?? null,
  }));
}

/** Off the shelf, into the bag. */
export async function runnerPickup(orderId: string): Promise<void> {
  await call("runner_pickup", { p_order: orderId });
}

/** Handed over at the door — with the student's scanned code, or on the runner's word. */
export async function runnerDeliver(orderId: string, code: string | null): Promise<void> {
  await call("runner_deliver", { p_order: orderId, p_code: code?.trim() || null });
}

/** Back to the desk, with the reason the student hears. */
export async function runnerReturn(orderId: string, reason: string): Promise<void> {
  await call("runner_return", { p_order: orderId, p_reason: reason.trim() });
}

async function call(fn: string, args: Record<string, unknown>): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc(fn, args);
  if (error) throw new Error(explain(error.message));
  // The student's message was just queued; send it now, and let every
  // screen that lists orders hear about it.
  pokeDispatch();
  changed("orders");
}

/* ---------- the admin's side ---------- */

export interface RunnerRow {
  user_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: Exclude<RunnerStatus, "none">;
  requested_at: string;
  approved_at: string | null;
  removed_at: string | null;
  delivered: number;
  carrying: number;
}

export async function adminRunners(): Promise<RunnerRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("admin_runners");
  if (error) throw new Error(explain(error.message));
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    user_id: String(r.user_id),
    name: (r.name as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    status: (r.status as RunnerRow["status"]) ?? "requested",
    requested_at: String(r.requested_at),
    approved_at: (r.approved_at as string | null) ?? null,
    removed_at: (r.removed_at as string | null) ?? null,
    delivered: num(r.delivered),
    carrying: num(r.carrying),
  }));
}

/** Approve a request, or remove a runner — whatever they carry goes back to the desk's shelf. */
export async function setRunner(userId: string, active: boolean): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("admin_set_runner", { p_user: userId, p_active: active });
  if (error) throw new Error(explain(error.message));
  pokeDispatch();
}

/** Grant by email — the account must have signed in to Printifi once. */
export async function addRunner(email: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("admin_add_runner", { p_email: email.trim() });
  if (error) throw new Error(explain(error.message));
}

export interface DeliveryPolicy {
  enabled: boolean;
  fee: number;
  /** Hostels the runner serves; empty means any the student names. */
  areas: string[];
  /** A line the student reads next to the choice — round times, mostly. */
  note: string;
}

export async function setDeliveryPolicy(policy: DeliveryPolicy): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("set_delivery_policy", {
    p_enabled: policy.enabled,
    p_fee: policy.fee,
    p_areas: policy.areas.map((a) => a.trim()).filter(Boolean),
    p_note: policy.note.trim() || null,
  });
  if (error) throw new Error(explain(error.message));
}

/** Which desks the runner collects from. */
export async function setDeskDelivery(operatorId: string, on: boolean): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("set_desk_delivery", { p_operator: operatorId, p_on: on });
  if (error) throw new Error(explain(error.message));
}

export interface DeliveryReport {
  delivered: number;
  in_flight: number;
  waiting: number;
  returned: number;
  fees_earned: number;
  /** Cash taken at doors by runners: Printifi's to hold, the desks' price on it credited. */
  cash_in_hand: number;
  /** Delivery fees paid to desks directly, owed back to Printifi. */
  fees_owed_by_desks: number;
  active_runners: number;
  requests: number;
}

export async function adminDeliveryReport(): Promise<DeliveryReport | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("admin_delivery_report");
  if (error || !data?.[0]) return null;
  const r = data[0] as Record<string, unknown>;
  return {
    delivered: num(r.delivered),
    in_flight: num(r.in_flight),
    waiting: num(r.waiting),
    returned: num(r.returned),
    fees_earned: num(r.fees_earned),
    cash_in_hand: num(r.cash_in_hand),
    fees_owed_by_desks: num(r.fees_owed_by_desks),
    active_runners: num(r.active_runners),
    requests: num(r.requests),
  };
}

function explain(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("does not exist") || m.includes("schema cache") || m.includes("could not find")) {
    return "This needs migrations 0045 and 0046 — run them in order from supabase/migrations.";
  }
  return message;
}
