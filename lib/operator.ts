"use client";

import { ensureSession, getSupabase } from "./supabase/client";
import type { OrderRow, OrderStatus } from "./orders";

/* ============================================================
   Applications — asking to run a desk
   ============================================================ */

export type ApplicationStatus = "pending" | "approved" | "rejected" | "withdrawn";

export interface ApplicationDraft {
  display_name: string;
  campus: string;
  location: string;
  phone: string;
  machine: string;
  note: string;
}

/** The applicant's own most recent application. Never carries the code. */
export interface MyApplication {
  id: string;
  display_name: string;
  campus: string;
  status: ApplicationStatus;
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
  /** Approved, and the owner code the admin holds is still usable. */
  code_live: boolean;
  code_expires_at: string | null;
}

export async function myApplication(): Promise<MyApplication | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const session = await ensureSession();
  if (session.status !== "ready") return null;
  const { data, error } = await supabase.rpc("my_application");
  if (error) throw new Error(explain(error.message));
  return (data?.[0] as MyApplication) ?? null;
}

export async function applyForDesk(draft: ApplicationDraft): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("apply_for_desk", {
    p_display_name: draft.display_name.trim(),
    p_campus: draft.campus.trim(),
    p_location: draft.location.trim() || null,
    p_phone: draft.phone.trim(),
    p_machine: draft.machine.trim() || null,
    p_note: draft.note.trim() || null,
  });
  if (error) throw new Error(explain(error.message));
}

export async function withdrawApplication(id: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("withdraw_application", { p_application: id });
  if (error) throw new Error(explain(error.message));
}

/* ---------- the admin's side ---------- */

export interface Application {
  id: string;
  user_id: string;
  display_name: string;
  campus: string;
  location: string | null;
  phone: string;
  machine: string | null;
  note: string | null;
  status: ApplicationStatus;
  review_note: string | null;
  reviewed_at: string | null;
  operator_id: string | null;
  created_at: string;
  applicant_name: string | null;
  applicant_email: string | null;
  /** The owner code while it's live; null once used, cancelled or expired. */
  code: string | null;
  code_expires_at: string | null;
  code_claimed: boolean;
}

export async function adminApplications(status?: ApplicationStatus): Promise<Application[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("admin_applications", { p_status: status ?? null });
  if (error) throw new Error(explain(error.message));
  return (data ?? []) as Application[];
}

/** Creates the desk and mints a code for that applicant, in one transaction. */
export async function approveApplication(
  id: string,
  note?: string,
): Promise<{ operator_id: string; code: string; expires_at: string }> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { data, error } = await supabase.rpc("approve_application", {
    p_application: id,
    p_note: note?.trim() || null,
  });
  if (error) throw new Error(explain(error.message));
  const row = data?.[0] as { operator_id: string; code: string; expires_at: string } | undefined;
  if (!row) throw new Error("The database made no code.");
  return row;
}

export async function rejectApplication(id: string, note: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("reject_application", { p_application: id, p_note: note.trim() });
  if (error) throw new Error(explain(error.message));
}

/* ============================================================
   Admin — desks
   ============================================================ */

export async function isAdmin(): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc("is_admin");
  if (error) return false;
  return Boolean(data);
}

/** Whether anyone holds admin yet — decides if the seat can still be claimed. */
export async function adminsExist(): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return true;
  const { data, error } = await supabase.rpc("admins_exist");
  if (error) return true;
  return Boolean(data);
}

export interface Desk {
  id: string;
  name: string;
  campus: string;
  is_open: boolean;
  created_at: string;
  staff_count: number;
  open_invites: number;
  /** The live owner code while nobody is on the desk yet; null after. */
  owner_code: string | null;
  owner_code_expires_at: string | null;
}

/** Every desk, with how many people run it. Admins only, enforced in SQL. */
export async function adminDesks(): Promise<Desk[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("admin_desks");
  if (error) throw new Error(explain(error.message));
  return ((data ?? []) as Desk[]).map((d) => ({
    ...d,
    staff_count: Number(d.staff_count),
    open_invites: Number(d.open_invites),
    owner_code: d.owner_code ?? null,
    owner_code_expires_at: d.owner_code_expires_at ?? null,
  }));
}

/**
 * A new desk with nobody on it. The admin then makes a join code for it and
 * hands that to the owner — see `createInvite` in lib/desk.ts.
 */
export async function createDesk(name: string, campus: string): Promise<string> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { data, error } = await supabase.rpc("create_operator", {
    p_name: name.trim(),
    p_campus: campus.trim(),
  });
  if (error) throw new Error(explain(error.message));
  if (typeof data !== "string") throw new Error("The database returned no desk id.");
  return data;
}

/* ============================================================
   Portal
   ============================================================ */

export interface OperatorStats {
  pending: number;
  printing: number;
  ready: number;
  done_today: number;
  declined_today: number;
  pages_today: number;
  revenue_today: number;
  scheduled: number;
  median_minutes: number;
}

export async function operatorStats(operatorId: string): Promise<OperatorStats | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.rpc("operator_stats", { p_operator: operatorId });
  return (data?.[0] as OperatorStats) ?? null;
}

const ORDER_SELECT =
  "*, order_items(id, name, pages, colour_pages, selected_pages, price, config, ordinal)";

/**
 * Every live order, plus the finished ones from the last fortnight.
 *
 * The earlier version took the oldest two hundred rows, so the day an operator
 * passed two hundred lifetime orders, every new one silently stopped showing
 * up. Live orders are never cut; history is bounded by time, not by count.
 * Oldest first, because that is the order a queue is served in.
 */
export async function operatorOrders(
  operatorId: string,
  { limit = 1000, sinceDays = 14 }: { limit?: number; sinceDays?: number } = {},
): Promise<OrderRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("operator_id", operatorId)
    .or(`status.in.(placed,queued,printing,finishing,ready),created_at.gte.${since}`)
    .order("is_priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(limit);
  return (data ?? []) as OrderRow[];
}

/** Accepting is the moment money changed hands at the desk. */
export async function acceptOrder(orderId: string): Promise<void> {
  await patchOrder(orderId, { status: "queued", note: "Payment taken" });
}

export async function declineOrder(orderId: string, reason: string): Promise<void> {
  await patchOrder(orderId, {
    status: "cancelled",
    cancelled_by: "operator",
    note: reason,
  });
}

export async function setPriority(orderId: string, isPriority: boolean): Promise<void> {
  await patchOrder(orderId, { is_priority: isPriority });
}

export async function setOperatorNote(orderId: string, note: string): Promise<void> {
  await patchOrder(orderId, { operator_note: note.trim() || null });
}

export async function advance(orderId: string, to: OrderStatus, note: string): Promise<void> {
  await patchOrder(orderId, { status: to, note });
}

async function patchOrder(orderId: string, patch: Record<string, unknown>) {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from("orders").update(patch).eq("id", orderId);
  if (error) throw new Error(explain(error.message));
}

function explain(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("row-level security")) {
    return "The database refused that. Your sign-in may not be reaching Supabase — check the banner above.";
  }
  if (m.includes("does not exist") || m.includes("schema cache")) {
    if (m.includes("application") || m.includes("apply_for_desk")) {
      return "This needs migration 0024 — run supabase/migrations/0024_applications.sql.";
    }
    if (m.includes("admin_desks") || m.includes("create_operator")) {
      return "This needs migration 0019 — run supabase/migrations/0019_join_codes.sql.";
    }
    return "A table or function is missing. Run every migration in supabase/migrations, in order.";
  }
  return message;
}

/* ============================================================
   Files — the part that makes printing possible
   ============================================================ */

export interface SignedFile {
  documentId: string;
  name: string;
  url: string;
}

/**
 * Opens a document attached to an order.
 *
 * `claim_document_access` checks that the caller staffs the operator the job
 * was placed with and that the order is still live, records the access against
 * the student's audit trail, and returns the storage path. The URL is then
 * signed for a few minutes — long enough to print, short enough that a copied
 * link is worthless tomorrow.
 */
export async function openOrderFile(
  orderItemId: string,
  purpose: "print" | "preview" = "print",
): Promise<SignedFile> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");

  const { data, error } = await supabase.rpc("claim_document_access", {
    p_item: orderItemId,
    p_purpose: purpose,
  });
  if (error) throw new Error(explain(error.message));

  const row = data?.[0] as { document_id: string; storage_path: string; name: string } | undefined;
  if (!row) throw new Error("That item has no stored file.");

  const { data: signed, error: signError } = await supabase.storage
    .from("documents")
    .createSignedUrl(row.storage_path, 300);

  if (signError || !signed?.signedUrl) {
    throw new Error(
      signError?.message.includes("not found")
        ? "The file is no longer in storage — it may have been deleted after collection."
        : (signError?.message ?? "Couldn't open that file."),
    );
  }

  return { documentId: row.document_id, name: row.name, url: signed.signedUrl };
}

/* ---------- customer ---------- */

export interface Customer {
  name: string | null;
  phone: string | null;
  roll_no: string | null;
  hostel: string | null;
  room: string | null;
}

/** Readable only while the order is live — see the policy in 0011. */
export async function orderCustomer(userId: string): Promise<Customer | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from("profiles")
    .select("name, phone, roll_no, hostel, room")
    .eq("id", userId)
    .maybeSingle();
  return (data as Customer) ?? null;
}

/* ---------- refunds ---------- */

export async function refundOrder(orderId: string, amount: number, note: string): Promise<void> {
  await patchOrder(orderId, {
    refunded_at: new Date().toISOString(),
    refund_amount: amount,
    refund_note: note,
  });
}

/* ---------- day summary ---------- */

export interface RangeStats {
  orders: number;
  collected: number;
  declined: number;
  pages: number;
  colour_pages: number;
  revenue: number;
  refunded: number;
  cash_total: number;
  upi_total: number;
  uncollected: number;
  median_minutes: number;
  /** Printify's share of the collected, unrefunded orders in the window. */
  platform_fee: number;
}

export async function statsForRange(
  operatorId: string,
  from: Date,
  to: Date = new Date(),
): Promise<RangeStats | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.rpc("operator_stats_range", {
    p_operator: operatorId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  return (data?.[0] as RangeStats) ?? null;
}
