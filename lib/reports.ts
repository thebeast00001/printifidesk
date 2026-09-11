"use client";

import { ensureSession, getSupabase } from "./supabase/client";

/**
 * Saying a print came out wrong.
 *
 * This is worth having only because the operator's refund control exists: a
 * complaint that lands nowhere is worse than no button at all. What it does not
 * do is decide anything — the report is a message to the desk, and the desk
 * chooses whether to reprint or refund. Nothing here touches the money.
 */

export type ReportStatus = "open" | "resolved";

export interface OrderReport {
  id: string;
  order_id: string;
  user_id: string;
  reason: string;
  detail: string | null;
  status: ReportStatus;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

/** The wording a student picks from. Free text is for everything else. */
export const REPORT_REASONS = [
  "Pages are streaked or faded",
  "Printed in black & white, not colour",
  "Wrong pages, or pages missing",
  "Printed one side, not both",
  "Not stapled as asked",
  "Never collected it — didn't get there in time",
] as const;

export async function submitReport(
  orderId: string,
  reason: string,
  detail: string,
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");

  const session = await ensureSession();
  if (session.status !== "ready") throw new Error("Sign in to report a problem.");

  const { error } = await supabase.from("order_reports").insert({
    order_id: orderId,
    user_id: session.userId,
    reason,
    detail: detail.trim() || null,
  });

  if (error) throw new Error(explain(error.message));
}

/** Every report on one order — the student sees their own, staff see them all. */
export async function reportsFor(orderId: string): Promise<OrderReport[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("order_reports")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false });
  return (data ?? []) as OrderReport[];
}

/** Everything still open across an operator's orders, newest first. */
export async function openReports(orderIds: string[]): Promise<OrderReport[]> {
  const supabase = getSupabase();
  if (!supabase || orderIds.length === 0) return [];
  const { data } = await supabase
    .from("order_reports")
    .select("*")
    .in("order_id", orderIds)
    .eq("status", "open")
    .order("created_at", { ascending: false });
  return (data ?? []) as OrderReport[];
}

/**
 * Closes a report. `resolved_at` is stamped by a trigger rather than sent from
 * here, so the time is the database's and not a client clock.
 */
export async function resolveReport(id: string, resolution: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from("order_reports")
    .update({ status: "resolved", resolution: resolution.trim() || null })
    .eq("id", id);
  if (error) throw new Error(explain(error.message));
}

function explain(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("order_reports_one_open")) {
    return "You've already reported this order — the operator can see it.";
  }
  if (m.includes("row-level security")) {
    return "You can only report an order of your own, once it's been printed.";
  }
  if (m.includes("does not exist") || m.includes("schema cache")) {
    return "Reporting needs migration 0013 — run it in the Supabase SQL editor.";
  }
  return message;
}
