"use client";

import { ensureSession, getSupabase } from "./supabase/client";
import type { OrderRow, OrderStatus } from "./orders";

/* ============================================================
   Applications
   ============================================================ */

export type ApplicationStatus = "pending" | "approved" | "rejected" | "withdrawn";

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
}

export interface ApplicationDraft {
  display_name: string;
  campus: string;
  location: string;
  phone: string;
  machine: string;
  note: string;
}

/** The applicant's own most recent application, whatever its state. */
export async function myApplication(): Promise<Application | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const session = await ensureSession();
  if (session.status !== "ready") return null;

  const { data } = await supabase
    .from("operator_applications")
    .select("*")
    .eq("user_id", session.userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Application) ?? null;
}

export async function submitApplication(draft: ApplicationDraft): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const session = await ensureSession();
  if (session.status !== "ready") throw new Error("Sign in to apply.");

  const { error } = await supabase.from("operator_applications").insert({
    user_id: session.userId,
    display_name: draft.display_name.trim(),
    campus: draft.campus.trim(),
    location: draft.location.trim() || null,
    phone: draft.phone.trim(),
    machine: draft.machine.trim() || null,
    note: draft.note.trim() || null,
    status: "pending",
  });

  if (error) throw new Error(explain(error.message));
}

export async function withdrawApplication(id: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from("operator_applications")
    .update({ status: "withdrawn" })
    .eq("id", id);
  if (error) throw new Error(explain(error.message));
}

/* ---------- reviewer side ---------- */

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

/**
 * Takes the first admin seat. Succeeds only while nobody holds it, so it can't
 * be used to escalate once the deployment is set up.
 */
export async function claimFirstAdmin(): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { data, error } = await supabase.rpc("claim_first_admin");
  if (error) throw new Error(explain(error.message));
  return Boolean(data);
}

export async function listApplications(status?: ApplicationStatus): Promise<Application[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  let query = supabase
    .from("operator_applications")
    .select("*")
    .order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data } = await query;
  return (data ?? []) as Application[];
}

export async function approveApplication(id: string, note?: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.rpc("approve_application", {
    p_application: id,
    p_note: note ?? null,
  });
  if (error) throw new Error(explain(error.message));
}

export async function rejectApplication(id: string, note: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.rpc("reject_application", {
    p_application: id,
    p_note: note,
  });
  if (error) throw new Error(explain(error.message));
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
  "*, order_items(id, name, pages, colour_pages, selected_pages, price, config)";

/** Everything this operator has, newest first — the portal filters locally. */
export async function operatorOrders(operatorId: string, limit = 200): Promise<OrderRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("operator_id", operatorId)
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
  if (m.includes("operator_applications_one_pending")) {
    return "You already have an application waiting to be reviewed.";
  }
  if (m.includes("does not exist") || m.includes("schema cache")) {
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
