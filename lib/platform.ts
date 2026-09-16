"use client";

import { getSupabase } from "./supabase/client";
import type { UpiKind } from "./upi";

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
  /** Merchant ids take a pre-filled amount in the desk's settle-up QR; personal ones don't. */
  payee_kind: UpiKind;
  /** Days past month-end before an unsettled fee locks the desk closed. */
  grace_days: number;
  /** 0040: the day Printify pays desks their online share — 1 Monday … 7 Sunday. */
  payout_weekday: number;
  updated_at: string;
}

const EMPTY: PlatformSettings = {
  fee_percent: 0,
  fee_min: 0,
  payee_vpa: null,
  payee_name: null,
  payee_kind: "personal",
  grace_days: 15,
  payout_weekday: 1,
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
  // `*`, not a column list: a column this project hasn't got yet (0025's
  // grace_days, 0027's payee_kind) must read as its default, not as "no
  // fee" — the quote would then disagree with place_order.
  const { data, error } = await supabase.from("platform_settings").select("*").eq("id", true).maybeSingle();
  // A project that hasn't run 0022 prices as it did before: no fee.
  const value: PlatformSettings = error || !data
    ? EMPTY
    : {
        fee_percent: Number(data.fee_percent),
        fee_min: Number(data.fee_min),
        payee_vpa: data.payee_vpa ?? null,
        payee_name: data.payee_name ?? null,
        payee_kind: data.payee_kind === "merchant" ? "merchant" : "personal",
        grace_days: Number(data.grace_days ?? 15),
        payout_weekday: Number(data.payout_weekday ?? 1),
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
  payeeKind: UpiKind;
}): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("set_platform_fee", {
    p_percent: input.percent,
    p_min: input.min,
    p_vpa: input.vpa.trim() || null,
    p_name: input.name.trim() || null,
    p_grace_days: input.graceDays,
    p_payee_kind: input.payeeKind,
  });
  if (error) throw new Error(explain(error.message));
  cache = null;
}

/* ---------- the ledger ---------- */

export interface FeeWindow {
  /** Fees on orders paid through Printify: retained at source, not owed. Zero before 0032. */
  retained?: number;
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
  /** Fees taken at source on orders paid through Printify, in the window. Zero before 0032. */
  retained: number;
  gateway_status: "off" | "collect" | "pending" | "active" | "blocked";
}

/* ---------- payouts: what Printify owes a desk from online payments (0035) ---------- */

export interface PayoutBalance {
  owed: number;
  paid_out: number;
  balance: number;
  orders: number;
}

export interface PayoutWindow {
  orders: number;
  gross: number;
  fee: number;
  share: number;
}

export interface DeskPayoutRow {
  operator_id: string;
  name: string;
  campus: string;
  orders: number;
  gross: number;
  fee: number;
  share: number;
  owed: number;
  paid_out: number;
  balance: number;
  gateway_status: "off" | "collect" | "pending" | "active" | "blocked";
}

export interface Payout {
  id: number;
  amount: number;
  note: string | null;
  created_at: string;
  /** 0040: the window of online orders this payout covered; null on payouts recorded before it. */
  covers_from: string | null;
  covers_to: string | null;
}

/** One online-paid order as the desk's statement shows it (0040). */
export interface PayoutOrderRow {
  id: string;
  token: string | null;
  paid_at: string;
  status: string;
  total: number;
  platform_fee: number;
  refund_amount: number | null;
  share: number;
  /** Cashfree's payment id — the line the desk can check against Printify's word. */
  payment_id: string | null;
}

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/**
 * The next payout date for a given weekday (1 Monday … 7 Sunday), in the
 * desk's timezone. Today counts if today is the day. Returned as a Date at
 * local midnight, for formatting; the promise is the day, not a time.
 */
export function nextPayoutDate(weekday: number, tz = "Asia/Kolkata", from: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(from);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const todayIndex = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(get("weekday").slice(0, 3).toLowerCase());
  const want = Math.min(7, Math.max(1, Math.round(weekday))) - 1;
  const ahead = (want - todayIndex + 7) % 7;
  const local = new Date(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
  local.setDate(local.getDate() + ahead);
  return local;
}

const num = (v: unknown) => Number(v ?? 0);

/** What a desk is owed from online payments Printify collected. Staff of the desk, or the admin. */
export async function payoutBalance(operatorId: string): Promise<PayoutBalance> {
  const supabase = getSupabase();
  if (!supabase) return { owed: 0, paid_out: 0, balance: 0, orders: 0 };
  const { data, error } = await supabase.rpc("payout_balance", { p_operator: operatorId });
  if (error) throw new Error(explain(error.message));
  const r = (data?.[0] ?? {}) as Record<string, unknown>;
  return { owed: num(r.owed), paid_out: num(r.paid_out), balance: num(r.balance), orders: num(r.orders) };
}

export async function payoutWindow(operatorId: string, from: Date, to: Date = new Date()): Promise<PayoutWindow> {
  const supabase = getSupabase();
  if (!supabase) return { orders: 0, gross: 0, fee: 0, share: 0 };
  const { data, error } = await supabase.rpc("payout_window", { p_operator: operatorId, p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw new Error(explain(error.message));
  const r = (data?.[0] ?? {}) as Record<string, unknown>;
  return { orders: num(r.orders), gross: num(r.gross), fee: num(r.fee), share: num(r.share) };
}

export async function listPayouts(operatorId: string): Promise<Payout[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  // `*`: covers_from/covers_to arrive with 0040; before it they read as null.
  const { data, error } = await supabase
    .from("platform_payouts")
    .select("*")
    .eq("operator_id", operatorId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(explain(error.message));
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    amount: num(r.amount),
    note: (r.note as string | null) ?? null,
    created_at: String(r.created_at),
    covers_from: (r.covers_from as string | null) ?? null,
    covers_to: (r.covers_to as string | null) ?? null,
  }));
}

/** The desk's statement: every online-paid order in the window, with the share on each. Owner or admin. */
export async function payoutOrders(operatorId: string, from: Date | string, to: Date | string = new Date()): Promise<PayoutOrderRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const iso = (d: Date | string) => (typeof d === "string" ? d : d.toISOString());
  const { data, error } = await supabase.rpc("payout_orders", { p_operator: operatorId, p_from: iso(from), p_to: iso(to) });
  if (error) throw new Error(explain(error.message));
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    token: (r.token as string | null) ?? null,
    paid_at: String(r.paid_at),
    status: String(r.status),
    total: num(r.total),
    platform_fee: num(r.platform_fee),
    refund_amount: r.refund_amount === null || r.refund_amount === undefined ? null : num(r.refund_amount),
    share: num(r.share),
    payment_id: (r.payment_id as string | null) ?? null,
  }));
}

/** Admin only, enforced in SQL. "I sent the desk this much, for everything up to now." */
export async function recordPayout(operatorId: string, amount: number, note: string, coversTo: Date = new Date()): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("record_payout", {
    p_operator: operatorId,
    p_amount: amount,
    p_note: note.trim() || null,
    p_covers_to: coversTo.toISOString(),
  });
  if (error) throw new Error(explain(error.message));
}

/** Admin only: the weekday desks are paid on (1 Monday … 7 Sunday). */
export async function setPayoutDay(weekday: number): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("set_payout_day", { p_weekday: weekday });
  if (error) throw new Error(explain(error.message));
  cache = null;
}

export async function adminPayoutDesks(from: Date, to: Date = new Date()): Promise<DeskPayoutRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("admin_payout_desks", { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw new Error(explain(error.message));
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    operator_id: String(r.operator_id),
    name: String(r.name),
    campus: String(r.campus),
    orders: num(r.orders),
    gross: num(r.gross),
    fee: num(r.fee),
    share: num(r.share),
    owed: num(r.owed),
    paid_out: num(r.paid_out),
    balance: num(r.balance),
    gateway_status: (["off", "collect", "pending", "active", "blocked"].includes(String(r.gateway_status)) ? r.gateway_status : "off") as DeskPayoutRow["gateway_status"],
  }));
}

/** Admin only. Turns "Printify collects" on or off for a desk; a split desk stays split. */
export async function setGatewayCollect(operatorId: string, on: boolean): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("No database connection.");
  const { error } = await supabase.rpc("set_gateway_collect", { p_operator: operatorId, p_on: on });
  if (error) throw new Error(explain(error.message));
}

/** One collected order in the fee ledger, as the admin sees it: money, not people. */
export interface FeeOrderRow {
  id: string;
  token: string | null;
  collected_at: string;
  total: number;
  platform_fee: number;
  payment_method: "upi" | "cash" | "gateway" | null;
  refund_amount: number | null;
  /** Set when the fee was taken at source (paid through Printify); null when the desk owes it. */
  fee_settled_at: string | null;
}

/** Every collected, unrefunded order at a desk in the window, newest first. Admin only. */
export async function adminFeeOrders(operatorId: string, from: Date, to: Date = new Date()): Promise<FeeOrderRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("admin_fee_orders", {
    p_operator: operatorId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw new Error(explain(error.message));
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    token: r.token === null || r.token === undefined ? null : String(r.token),
    collected_at: String(r.collected_at),
    total: Number(r.total),
    platform_fee: Number(r.platform_fee),
    payment_method: (r.payment_method as FeeOrderRow["payment_method"]) ?? null,
    refund_amount: r.refund_amount === null || r.refund_amount === undefined ? null : Number(r.refund_amount),
    fee_settled_at: r.fee_settled_at === null || r.fee_settled_at === undefined ? null : String(r.fee_settled_at),
  }));
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
  const row = data?.[0] as { orders: number; fee: number | string; retained?: number | string } | undefined;
  return { orders: Number(row?.orders ?? 0), fee: Number(row?.fee ?? 0), retained: Number(row?.retained ?? 0) };
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
    retained: Number(r.retained ?? 0),
    gateway_status: (["off", "pending", "active", "blocked"].includes(String(r.gateway_status)) ? r.gateway_status : "off") as DeskFeeRow["gateway_status"],
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
