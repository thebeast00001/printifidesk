"use client";

import { getSupabase } from "./supabase/client";

/**
 * The platform fee — Printify's share of every order — and the ledger of
 * what each desk owes and has settled. All of it lives in Postgres
 * (migration 0022); this file is the thin client over it.
 */

export interface PlatformSettings {
  fee_percent: number;
  fee_min: number;
  payee_vpa: string | null;
  payee_name: string | null;
  /** Days past month-end before an unsettled fee locks the desk closed. */
  grace_days: number;
  updated_at: string;
}

const EMPTY: PlatformSettings = {
  fee_percent: 0,
  fee_min: 0,
  payee_vpa: null,
  payee_name: null,
  grace_days: 15,
  updated_at: "",
};

let cache: { at: number; value: PlatformSettings } | null = null;
let pending: Promise<PlatformSettings> | null = null;
const FRESH_MS = 60_000;

/**
 * The one settings row, cached for a minute. Every operator fetch merges it
 * onto the row so `rateCardOf()` prices with it — a student's quote, the
 * desk's preview and the stored snapshot all agree. Callers that arrive
 * while the first fetch is in flight share it rather than each asking.
 */
export async function platformSettings(force = false): Promise<PlatformSettings> {
  if (!force && cache && Date.now() - cache.at < FRESH_MS) return cache.value;
  if (!force && pending) return pending;
  pending = fetchSettings().finally(() => {
    pending = null;
  });
  return pending;
}

async function fetchSettings(): Promise<PlatformSettings> {
  const supabase = getSupabase();
  if (!supabase) return EMPTY;
  const { data, error } = await supabase
    .from("platform_settings")
    .select("fee_percent, fee_min, payee_vpa, payee_name, grace_days, updated_at")
    .eq("id", true)
    .maybeSingle();
  // A project that hasn't run 0022 prices as it did before: no fee.
  const value: PlatformSettings = error || !data
    ? EMPTY
    : {
        fee_percent: Number(data.fee_percent),
        fee_min: Number(data.fee_min),
        payee_vpa: data.payee_vpa ?? null,
        payee_name: data.payee_name ?? null,
        grace_days: Number(data.grace_days ?? 15),
        updated_at: data.updated_at,
      };
  cache = { at: Date.now(), value };
  return value;
}

/** Admin only, enforced in SQL. */
export async function setPlatformFee(input: {
  percent: number;
  min: number;
  vpa: string;
  name: string;
  graceDays: number;
}): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("set_platform_fee", {
    p_percent: input.percent,
    p_min: input.min,
    p_vpa: input.vpa.trim() || null,
    p_name: input.name.trim() || null,
    p_grace_days: input.graceDays,
  });
  if (error) throw new Error(explain(error.message));
  cache = null;
}

/* ---------- the ledger ---------- */

export interface FeeWindow {
  orders: number;
  fee: number;
}

export interface FeeBalance {
  accrued: number;
  settled: number;
  outstanding: number;
}

/** What's due, and whether the desk is locked for it. */
export interface FeeStatus {
  outstanding: number;
  /** Fee on orders collected before this month, minus everything settled. */
  due: number;
  /** The month that fee belongs to (its first day). */
  due_month: string;
  grace_days: number;
  /** The day an unsettled `due` starts locking the desk. */
  locks_on: string;
  overdue: boolean;
}

export async function feeStatus(operatorId: string): Promise<FeeStatus | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("fee_status", { p_operator: operatorId });
  if (error) throw new Error(explain(error.message));
  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    outstanding: Number(row.outstanding),
    due: Number(row.due),
    due_month: String(row.due_month),
    grace_days: Number(row.grace_days),
    locks_on: String(row.locks_on),
    overdue: Boolean(row.overdue),
  };
}

export interface Settlement {
  id: number;
  operator_id: string;
  amount: number | string;
  note: string | null;
  recorded_by: string;
  created_at: string;
}

export interface DeskFeeRow {
  operator_id: string;
  name: string;
  campus: string;
  orders: number;
  fee: number;
  accrued: number;
  settled: number;
  outstanding: number;
}

/** Fee owed on orders collected in a window. Staff of the desk, or the admin. */
export async function feeWindow(operatorId: string, from: Date, to: Date = new Date()): Promise<FeeWindow> {
  const supabase = getSupabase();
  if (!supabase) return { orders: 0, fee: 0 };
  const { data, error } = await supabase.rpc("fee_window", {
    p_operator: operatorId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw new Error(explain(error.message));
  const row = data?.[0] as { orders: number; fee: number | string } | undefined;
  return { orders: Number(row?.orders ?? 0), fee: Number(row?.fee ?? 0) };
}

export async function feeBalance(operatorId: string): Promise<FeeBalance> {
  const supabase = getSupabase();
  if (!supabase) return { accrued: 0, settled: 0, outstanding: 0 };
  const { data, error } = await supabase.rpc("fee_balance", { p_operator: operatorId });
  if (error) throw new Error(explain(error.message));
  const row = data?.[0] as Record<string, number | string> | undefined;
  return {
    accrued: Number(row?.accrued ?? 0),
    settled: Number(row?.settled ?? 0),
    outstanding: Number(row?.outstanding ?? 0),
  };
}

export async function listSettlements(operatorId: string, limit = 12): Promise<Settlement[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("platform_settlements")
    .select("*")
    .eq("operator_id", operatorId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as Settlement[];
}

/** Every desk's window figures and all-time balance. Admin only. */
export async function adminFeeDesks(from: Date, to: Date = new Date()): Promise<DeskFeeRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("admin_fee_desks", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw new Error(explain(error.message));
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    operator_id: String(r.operator_id),
    name: String(r.name),
    campus: String(r.campus),
    orders: Number(r.orders),
    fee: Number(r.fee),
    accrued: Number(r.accrued),
    settled: Number(r.settled),
    outstanding: Number(r.outstanding),
  }));
}

export async function recordSettlement(operatorId: string, amount: number, note: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("record_settlement", {
    p_operator: operatorId,
    p_amount: amount,
    p_note: note.trim() || null,
  });
  if (error) throw new Error(explain(error.message));
}

/* ---------- windows ---------- */

export type FeePeriod = "today" | "week" | "month";

/**
 * Calendar windows in the viewer's own time: today from midnight, this week
 * from Monday, this month from the 1st. Settlement is a calendar thing, so
 * these are calendar windows — not the rolling 7 and 30 days Takings uses
 * for a shop's own sense of pace.
 */
export function periodStart(period: FeePeriod, now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === "week") {
    const day = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - day);
  } else if (period === "month") {
    d.setDate(1);
  }
  return d;
}

function explain(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("does not exist") || m.includes("schema cache")) {
    if (m.includes("fee_status") || m.includes("grace")) {
      return "This needs migration 0025 — run supabase/migrations/0025_fee_lock.sql.";
    }
    return "This needs migration 0022 — run supabase/migrations/0022_platform_fee.sql.";
  }
  return message;
}
