"use client";

import { ensureSession, getSupabase } from "./supabase/client";
import { platformSettings } from "./platform";
import { pokeDispatch } from "./push";
import type { PrintConfig, RateSource } from "./pricing";
import type { UpiKind } from "./upi";

export type OrderStatus =
  | "placed"
  | "queued"
  | "printing"
  | "finishing"
  | "ready"
  | "collected"
  | "cancelled"
  | "failed";

export interface OrderItemRow {
  id: string;
  name: string;
  pages: number;
  colour_pages: number;
  selected_pages: number[];
  price: number;
  /** This file's own settings. Empty on orders placed before 0013. */
  config: Partial<PrintConfig> | null;
  /** Position in the order the student added the files. 0 before 0017. */
  ordinal: number;
}

export interface OrderRow {
  id: string;
  operator_id: string;
  token: string | null;
  status: OrderStatus;
  total: number;
  full_colour_total: number;
  /** Printify's share, inside `total`. Zero before 0022. */
  platform_fee: number;
  /** What lifting to the next rupee added, inside `total`. Zero unless the desk rounds (0028). */
  rounding?: number | string | null;
  pages: number;
  colour_pages: number;
  config: PrintConfig;
  note: string | null;
  pickup_mode: "asap" | "scheduled";
  pickup_at: string | null;

  /* Portal handling (0007) */
  is_priority: boolean;
  operator_note: string | null;
  cancelled_by: "student" | "operator" | null;
  /** "gateway" is a payment through Printify (Cashfree), marked by the server. */
  payment_method: "upi" | "cash" | "gateway" | null;
  payment_claimed_at: string | null;
  payment_taken_at: string | null;
  payment_reference: string | null;
  /* 0028. The student's claim of what their app showed; the desk's record of
     what arrived; and when the desk collected a shortfall in cash. */
  payment_claimed_amount?: number | string | null;
  payment_received?: number | string | null;
  shortfall_cleared_at?: string | null;
  /** 0030: where the packet is, e.g. "B3". Assigned on 'ready'; the desk can change it. */
  shelf_slot?: string | null;
  /* 0032: the gateway's facts, written by the server only. */
  gateway_order_id?: string | null;
  gateway_payment_id?: string | null;
  gateway_paid_at?: string | null;
  fee_settled_at?: string | null;
  gateway_refund_id?: string | null;
  refunded_at: string | null;
  refund_amount: number | null;
  refund_note: string | null;
  /**
   * The secret in the student's QR (0016). Only the owner and the desk can
   * read the row, so only they ever see it; a scan that carries it is proof
   * the code came from the student's own screen.
   */
  handover_code: string | null;
  /**
   * The operator's rates at the moment the order was priced (0017). The
   * bill is rebuilt from this; null on orders placed before it existed.
   */
  rate_card: RateSource | null;
  user_id: string;
  accepted_at: string | null;
  started_at: string | null;
  created_at: string;
  queued_at: string | null;
  ready_at: string | null;
  collected_at: string | null;
  order_items?: OrderItemRow[];
}

export interface OrderEventRow {
  id: number;
  order_id: string;
  status: OrderStatus;
  note: string | null;
  /** Clerk id of whoever made the change; the trigger writes it. */
  actor: string | null;
  at: string;
}

export interface QueueStatus {
  /** 1-based place in the queue. Named `place` because `position` is a
      reserved word in Postgres and can't name a RETURNS TABLE column. */
  place: number;
  pages_ahead: number;
  wait_minutes: number;
}

export interface Operator {
  id: string;
  name: string;
  campus: string;
  /** Set by the operator, not by the clock — see migration 0004. */
  is_open: boolean;
  status_note: string | null;
  status_changed_at: string | null;

  /* Rate card — every operator sets their own (migration 0005). Numerics
     arrive as strings over PostgREST, so these are widened accordingly. */
  currency: string;
  bw_per_page: number | string;
  colour_per_page: number | string;
  duplex_discount: number | string;
  staple_price: number | string;
  bulk_threshold: number;
  bulk_multiplier: number | string;
  min_order: number | string;
  paper_gsm: number;
  pages_per_minute: number;
  handling_minutes: number;

  /* Listing + scheduling (0006) */
  short_name: string | null;
  is_listed: boolean;
  upi_vpa: string | null;
  upi_name: string | null;
  /* 0027: a merchant id takes a pre-filled amount; a personal one doesn't,
     so the student types it. Missing before 0027 — read as personal. */
  upi_kind?: UpiKind;
  upi_mc?: string | null;
  /** 0028: totals lifted to the next rupee, as a line on the bill. */
  round_to_rupee?: boolean;
  /** 0030: the shelf — rows A.. × slots per row. 0 rows means no shelf. */
  shelf_rows?: number;
  shelf_cols?: number;
  /** 0031: the standee's QR text, exactly as printed, when read from a photo. */
  upi_qr?: string | null;
  /** 0032: Cashfree Easy Split — "active" is the only state that takes a payment. */
  gateway_status?: "off" | "pending" | "active" | "blocked";
  accepts_cash: boolean;
  paper_stock: number | null;
  low_paper_at: number;
  toner_pages: number | null;
  low_toner_at: number;
  opens_at: string;
  closes_at: string;

  /* Shut by the admin (0026): unlisted and pinned closed, with the reason.
     Null for every desk that's running. */
  shut_at: string | null;
  shut_reason: string | null;

  /* Printify's share, from platform_settings — merged onto every fetched
     row so rateCardOf() prices with it. Not the desk's to edit. */
  platform_fee_percent?: number;
  platform_fee_min?: number;
}

/** Everything an operator can edit about how they price and run their desk. */
export type OperatorSettings = Partial<
  Pick<
    Operator,
    | "name"
    | "currency"
    | "bw_per_page"
    | "colour_per_page"
    | "duplex_discount"
    | "staple_price"
    | "bulk_threshold"
    | "bulk_multiplier"
    | "min_order"
    | "paper_gsm"
    | "pages_per_minute"
    | "handling_minutes"
    | "upi_vpa"
    | "upi_name"
    | "accepts_cash"
    | "opens_at"
    | "closes_at"
    | "paper_stock"
    | "toner_pages"
    | "low_paper_at"
    | "low_toner_at"
    | "upi_kind"
    | "upi_mc"
    | "round_to_rupee"
    | "shelf_rows"
    | "shelf_cols"
    | "upi_qr"
  >
>;

const OPERATOR_SELECT_LEGACY =
  "id, name, campus, is_open, status_note, status_changed_at, currency, bw_per_page, " +
  "colour_per_page, duplex_discount, staple_price, bulk_threshold, bulk_multiplier, " +
  "min_order, paper_gsm, pages_per_minute, handling_minutes, short_name, is_listed, opens_at, closes_at, " +
  "upi_vpa, upi_name, accepts_cash, paper_stock, low_paper_at, toner_pages, low_toner_at, " +
  "shut_at, shut_reason";
// Newest first. A deployment can go out before its migration is run;
// 42703 ("column does not exist") steps down one list at a time, so a
// project on 0028 still gets 0027's columns rather than none of them.
const OPERATOR_SELECTS = [
  OPERATOR_SELECT_LEGACY + ", upi_kind, upi_mc, round_to_rupee, shelf_rows, shelf_cols, upi_qr, gateway_status", // 0032
  OPERATOR_SELECT_LEGACY + ", upi_kind, upi_mc, round_to_rupee, shelf_rows, shelf_cols, upi_qr", // 0031
  OPERATOR_SELECT_LEGACY + ", upi_kind, upi_mc, round_to_rupee, shelf_rows, shelf_cols", // 0030
  OPERATOR_SELECT_LEGACY + ", upi_kind, upi_mc, round_to_rupee", // 0028
  OPERATOR_SELECT_LEGACY + ", upi_kind, upi_mc", // 0027
  OPERATOR_SELECT_LEGACY,
];
let operatorLevel = 0;

async function operatorQuery<T>(
  run: (select: string) => PromiseLike<{ data: T; error: { code?: string } | null }>,
): Promise<{ data: T; error: { code?: string } | null }> {
  // Judge by the level *this* call started at: several run at once on a
  // page load, and one stepping the shared level down mustn't stop the
  // others from retrying.
  let level = operatorLevel;
  let result = await run(OPERATOR_SELECTS[level]);
  while (result.error?.code === "42703" && level < OPERATOR_SELECTS.length - 1) {
    level += 1;
    if (level > operatorLevel) operatorLevel = level;
    result = await run(OPERATOR_SELECTS[level]);
  }
  return result;
}

export interface OperatorWait {
  open: boolean;
  pending_orders: number;
  pending_pages: number;
  wait_minutes: number;
}

export interface Totals {
  orders: number;
  pages: number;
  colour_pages: number;
  spent: number;
  saved: number;
}

/** Statuses where the job is still the counter's problem. */
export const ACTIVE_STATUSES: OrderStatus[] = [
  "placed",
  "queued",
  "printing",
  "finishing",
  "ready",
];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  placed: "Pay to start printing",
  queued: "In queue",
  printing: "Printing",
  finishing: "Binding",
  ready: "Ready for pickup",
  collected: "Collected",
  cancelled: "Cancelled",
  failed: "Couldn't print",
};

/** What the counter does next. Drives the operator console's buttons. */
export const NEXT_STATUS: Partial<Record<OrderStatus, { to: OrderStatus; label: string }[]>> = {
  placed: [
    { to: "queued", label: "Payment taken" },
    { to: "cancelled", label: "Cancel" },
  ],
  queued: [
    { to: "printing", label: "Start printing" },
    { to: "failed", label: "Can't print" },
  ],
  printing: [
    { to: "finishing", label: "Printed, binding" },
    { to: "ready", label: "Printed, ready" },
    { to: "failed", label: "Problem" },
  ],
  finishing: [{ to: "ready", label: "Ready for pickup" }],
  ready: [{ to: "collected", label: "Handed over" }],
};

const ORDER_SELECT = "*, order_items(id, name, pages, colour_pages, selected_pages, price, config, ordinal)";

export async function defaultOperatorId(): Promise<string | null> {
  return (await defaultOperator())?.id ?? null;
}

/**
 * Where an order's money stands, from the desk's record. `short` is what the
 * counter still has to take in cash; `over` is what the desk owes back —
 * both zero until the desk has confirmed, and `short` zero once cleared.
 */
export function paymentBalance(order: OrderRow): { short: number; over: number; received: number | null } {
  if (order.payment_received === null || order.payment_received === undefined) {
    return { short: 0, over: 0, received: null };
  }
  const received = Number(order.payment_received);
  const total = Number(order.total);
  const diff = Math.round((received - total) * 100) / 100;
  return {
    received,
    short: diff < 0 && !order.shortfall_cleared_at ? -diff : 0,
    over: diff > 0 ? diff : 0,
  };
}

/** The platform fee, stamped onto an operator row so every quote includes it. */
async function withFee<T extends Operator | null>(row: T): Promise<T> {
  if (!row) return row;
  const ps = await platformSettings();
  return { ...row, platform_fee_percent: ps.fee_percent, platform_fee_min: ps.fee_min };
}

/** Every operator a student can choose between. */
export async function listOperators(): Promise<Operator[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await operatorQuery((select) =>
    supabase.from("operators").select(select).eq("is_listed", true).order("created_at", { ascending: true }),
  );
  const ps = await platformSettings();
  return ((data ?? []) as unknown as Operator[]).map((o) => ({
    ...o,
    platform_fee_percent: ps.fee_percent,
    platform_fee_min: ps.fee_min,
  }));
}

/**
 * The operator a student prints through: their saved choice, else the first
 * listed one. Falling back rather than forcing a choice keeps a first-time
 * visitor from hitting a picker before they've seen a price.
 */
export async function defaultOperator(): Promise<Operator | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const session = await ensureSession();
  if (session.status === "ready") {
    const { data: profile } = await supabase
      .from("profiles")
      .select("default_operator_id")
      .eq("id", session.userId)
      .maybeSingle();

    const chosen = (profile as { default_operator_id?: string | null } | null)?.default_operator_id;
    if (chosen) {
      // A saved desk that has since been unlisted — or shut by the admin —
      // isn't one they can order from; fall through to the first that is.
      const operator = await getOperator(chosen, true);
      if (operator?.is_listed) return operator;
    }
  }

  const { data } = await operatorQuery((select) =>
    supabase
      .from("operators")
      .select(select)
      .eq("is_listed", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  );
  return withFee((data as unknown as Operator) ?? null);
}

/** Remembers which operator this student prints through. */
export async function chooseOperator(operatorId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const session = await ensureSession();
  if (session.status !== "ready") throw new Error("Sign in to change where you print.");

  const { error } = await supabase
    .from("profiles")
    .upsert({ id: session.userId, default_operator_id: operatorId }, { onConflict: "id" });
  if (error) throw new Error(friendly(error.message));
}

/**
 * One desk's row, cached briefly per id. The pay sheet, the order cards and
 * the capsule all ask for the same desk within seconds of each other; from
 * a phone that is a round trip apiece. `fresh` bypasses the cache for the
 * callers that react to a realtime change on the desk itself.
 */
const OPERATOR_CACHE_MS = 30_000;
const operatorCache = new Map<string, { at: number; value: Promise<Operator | null> }>();

export function forgetOperator(id?: string) {
  if (id) operatorCache.delete(id);
  else operatorCache.clear();
}

export async function getOperator(id: string, fresh = false): Promise<Operator | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const hit = operatorCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < OPERATOR_CACHE_MS) return hit.value;
  const value = (async () => {
    const { data } = await operatorQuery((select) =>
      supabase.from("operators").select(select).eq("id", id).maybeSingle(),
    );
    const row = await withFee((data as unknown as Operator) ?? null);
    // A miss isn't worth remembering; the next caller asks again.
    if (!row) operatorCache.delete(id);
    return row;
  })();
  operatorCache.set(id, { at: Date.now(), value });
  return value;
}

/** Names for a handful of desks — the switcher for someone on more than one. */
export async function operatorNames(ids: string[]): Promise<Record<string, string>> {
  const supabase = getSupabase();
  if (!supabase || ids.length === 0) return {};
  const { data } = await supabase.from("operators").select("id, name, short_name").in("id", ids);
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as { id: string; name: string; short_name: string | null }[]) {
    out[row.id] = row.short_name || row.name;
  }
  return out;
}

/** Update the rate card and desk settings. Staff only — RLS enforces it. */
export async function updateOperator(
  operatorId: string,
  patch: OperatorSettings,
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from("operators").update(patch).eq("id", operatorId);
  if (error) throw new Error(friendly(error.message));
  forgetOperator(operatorId);
}

/** Open or close Printify. Staff only — RLS enforces it. */
export async function setOperatorOpen(
  operatorId: string,
  isOpen: boolean,
  statusNote?: string | null,
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from("operators")
    .update({ is_open: isOpen, status_note: statusNote ?? null })
    .eq("id", operatorId);
  if (error) throw new Error(friendly(error.message));
  forgetOperator(operatorId);
}

export interface NewOrderInput {
  operatorId: string;
  /** `pickup_at` must be set when scheduled, and null when not — the database
      enforces the pairing. */
  pickupAt: string | null;
  items: {
    documentId: string | null;
    name: string;
    pages: number;
    colourPages: number;
    selectedPages: number[];
    /** This file's own print settings — see migration 0013. */
    config: PrintConfig;
  }[];
}

/**
 * Places the order.
 *
 * Since 0014 the browser sends the files and their settings, and the database
 * prices them: `place_order()` reads the operator's rate card and runs the
 * same arithmetic as `quoteOrder()` in one transaction. No total, no per-file
 * price and no "what full colour would have cost" leaves this machine — the
 * quote the student saw was a preview, and the row that comes back is the
 * price. The two agree to the rupee (the SQL harness checks 144 jobs for
 * exactly that), but if they ever didn't, the database's figure is the one
 * the operator is owed.
 *
 * The token, the first timeline event and the timestamps come from triggers
 * the same as before.
 */
export async function createOrder(input: NewOrderInput): Promise<OrderRow> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase isn't configured.");

  // Clerk owns the session — `supabase.auth.getUser()` is always empty here.
  const session = await ensureSession();
  if (session.status !== "ready") throw new Error("Sign in to place an order.");

  const { data: id, error } = await supabase.rpc("place_order", {
    p_operator: input.operatorId,
    p_items: input.items.map((item) => ({
      document_id: item.documentId,
      name: item.name,
      pages: item.pages,
      colour_pages: item.colourPages,
      selected_pages: item.selectedPages,
      config: item.config,
    })),
    p_pickup_at: input.pickupAt,
  });

  if (error) throw new Error(friendly(error.message));
  // The desk's "new order" push was just queued; send it now.
  pokeDispatch();

  const { data: order, error: readError } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", id as string)
    .single();

  if (readError || !order) {
    throw new Error(friendly(readError?.message ?? "The order was placed but couldn't be read back."));
  }

  return order as OrderRow;
}

export async function listOrders(): Promise<OrderRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return [];
  return (data ?? []) as OrderRow[];
}

/** The one job the status capsule follows: the newest that isn't finished. */
export async function activeOrder(): Promise<OrderRow | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as OrderRow) ?? null;
}

/**
 * The live order with its timeline embedded — one query where there were
 * two. PostgREST follows order_events.order_id, and the student's own RLS
 * policy on order_events applies inside the embed as it would outside.
 */
export async function activeOrderBundle(): Promise<{ order: OrderRow | null; events: OrderEventRow[] }> {
  const supabase = getSupabase();
  if (!supabase) return { order: null, events: [] };
  const { data } = await supabase
    .from("orders")
    .select(`${ORDER_SELECT}, order_events(*)`)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return { order: null, events: [] };
  const { order_events: embedded, ...rest } = data as OrderRow & { order_events?: OrderEventRow[] };
  const events = [...(embedded ?? [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { order: rest as OrderRow, events };
}

/** One line on the counter board: a token, where it is, and since when. No names. */
export interface BoardRow {
  token: string;
  status: OrderStatus;
  shelf_slot: string | null;
  since: string;
}

/**
 * What the screen at the counter shows. Open to anyone — a token is on
 * every slip on the shelf already — and empty for a shut desk.
 */
export async function boardRows(operatorId: string): Promise<BoardRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("board", { p_operator: operatorId });
  if (error) throw new Error(error.message);
  return (data ?? []) as BoardRow[];
}

/** The slot label for row r (1-based) and column c: A1, B7. What the trigger writes. */
export function shelfLabel(row: number, col: number): string {
  return `${String.fromCharCode(64 + row)}${col}`;
}

/** Every slot on a desk's shelf, in the order the trigger fills them. Empty when there's no shelf. */
export function shelfSlots(rows: number, cols: number): string[] {
  const out: string[] = [];
  for (let r = 1; r <= Math.min(8, Math.max(0, rows)); r++) {
    for (let c = 1; c <= Math.min(20, Math.max(1, cols)); c++) out.push(shelfLabel(r, c));
  }
  return out;
}

/** Queue position for the caller's newest live order — no id needed, so it can run alongside the order fetch. */
export async function queueStatusMine(): Promise<(QueueStatus & { order_id: string }) | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.rpc("queue_status_mine");
  return (data?.[0] as QueueStatus & { order_id: string }) ?? null;
}

export async function orderEvents(orderId: string): Promise<OrderEventRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("order_events")
    .select("*")
    .eq("order_id", orderId)
    .order("at", { ascending: true });
  return (data ?? []) as OrderEventRow[];
}

export async function queueStatus(orderId: string): Promise<QueueStatus | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.rpc("queue_status", { p_order: orderId });
  return (data?.[0] as QueueStatus) ?? null;
}

export async function operatorWait(operatorId: string): Promise<OperatorWait | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.rpc("operator_wait", { p_operator: operatorId });
  return (data?.[0] as OperatorWait) ?? null;
}

export async function myTotals(): Promise<Totals | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.rpc("my_totals");
  return (data?.[0] as Totals) ?? null;
}

export async function cancelOrder(orderId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { data, error } = await supabase
    .from("orders")
    .update({ status: "cancelled", note: "Cancelled by you" })
    .eq("id", orderId)
    .select("id");
  if (error) throw new Error(friendly(error.message));
  // RLS hides a row the student may no longer cancel (already printing) and
  // reports nothing; say so rather than reload into the same screen.
  if (!data || data.length === 0) throw new Error("Too late — the desk has already started on it. Ask at the counter.");
}

/* ---------- operator side ---------- */

export async function staffOperatorId(): Promise<string | null> {
  const ids = await staffOperatorIds();
  return ids[0] ?? null;
}

/**
 * Every desk this account is on, oldest first. Almost always one; a person
 * who covers two counters picks between them in the desk header.
 */
export async function staffOperatorIds(): Promise<string[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const session = await ensureSession();
  if (session.status !== "ready") return [];
  // Filtered by name as well as by RLS. The policy already returns only the
  // caller's rows; asking for them explicitly means a stray permissive
  // policy added in a dashboard can't make everyone look like staff.
  const { data } = await supabase
    .from("staff")
    .select("operator_id")
    .eq("user_id", session.userId)
    .order("created_at", { ascending: true });
  return ((data ?? []) as { operator_id: string }[]).map((r) => r.operator_id);
}

export async function operatorQueue(operatorId: string): Promise<OrderRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("operator_id", operatorId)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: true });
  return (data ?? []) as OrderRow[];
}

export async function advanceOrder(
  orderId: string,
  to: OrderStatus,
  note?: string,
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from("orders")
    .update({ status: to, note: note ?? null })
    .eq("id", orderId);
  if (error) throw new Error(friendly(error.message));
}

function friendly(message: string): string {
  if (message.includes("place_order")) {
    return "Ordering needs migration 0014 — run supabase/migrations/0014_hardening.sql.";
  }
  if (message.includes("does not exist") || message.includes("schema cache")) {
    return "The database tables don't exist yet. Run supabase/migrations/0001_init.sql.";
  }
  if (message.includes("row-level security")) {
    return "The database refused that change. Check the RLS policies in 0001_init.sql.";
  }
  // The RPC's own messages are written for the student; pass them through.
  if (/not yours|out of range|lot of orders|not taking orders|at least one file|split it in two/.test(message)) {
    return message;
  }
  if (message.includes("orders_pickup_at_matches_mode")) {
    return "A scheduled pickup needs a time, and an as-soon-as-possible order can't have one.";
  }
  if (message.includes("operators_rates_sane")) {
    return "Those rates are out of range. Prices can't be negative, and discounts are a share between 0 and 0.9.";
  }
  return message;
}
