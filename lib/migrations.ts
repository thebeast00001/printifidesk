"use client";

import { getSupabase } from "./supabase/client";

/**
 * Which migrations the live project has actually run.
 *
 * Each migration since the fee added something the app can probe from the
 * browser with the anon key: a column on a public table, or a function.
 * Missing ones are named with what breaks without them — because a
 * migration run out of order is a real failure mode: 0032's guard names a
 * column 0030 adds, and with 0030 skipped every student update on an
 * order (cancel, "I've paid") died with `record "new" has no field
 * "shelf_slot"` while the desk carried on fine.
 */
export interface MigrationProbe {
  id: string;
  /** What stops working while it's missing. */
  without: string;
  check: () => Promise<boolean>;
}

const column = (table: string, col: string) => async () => {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.from(table).select(col).limit(0);
  return !error;
};

const fn = (name: string, args: Record<string, unknown> = {}) => async () => {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.rpc(name, args);
  // 42883 / PGRST202: no such function. Anything else (permission, bad
  // args) means it exists.
  return !(error && (error.code === "42883" || error.code === "PGRST202" || /could not find the function/i.test(error.message)));
};

export const MIGRATION_PROBES: MigrationProbe[] = [
  { id: "0022", without: "no platform fee is priced or shown", check: column("platform_settings", "fee_percent") },
  { id: "0025", without: "fee panel shows no due date; overdue desks can open", check: column("platform_settings", "grace_days") },
  { id: "0026", without: "Shut this desk errors", check: column("operators", "shut_at") },
  { id: "0027", without: "every desk pays as a personal id", check: column("operators", "upi_kind") },
  { id: "0028", without: "no bill rounds; the confirm row's amount isn't kept", check: column("orders", "payment_received") },
  { id: "0029", without: "the capsule shows no queue position", check: fn("queue_status_mine") },
  { id: "0030", without: "students can't cancel or mark paid if 0032 is in; no shelf slots; the board says reconnecting", check: column("orders", "shelf_slot") },
  { id: "0031", without: "a Paytm desk's standee QR isn't kept", check: column("operators", "upi_qr") },
  { id: "0032", without: "online payment is never offered", check: column("orders", "gateway_paid_at") },
  { id: "0033", without: "Orders under a desk on /admin errors", check: fn("admin_fee_orders", { p_operator: "00000000-0000-0000-0000-000000000000", p_from: new Date(0).toISOString() }) },
  { id: "0035", without: "online payment can't be turned on for a desk; no payouts ledger", check: column("orders", "gateway_split") },
];

export interface MigrationReport {
  present: string[];
  missing: MigrationProbe[];
}

export async function probeMigrations(): Promise<MigrationReport> {
  const results = await Promise.all(MIGRATION_PROBES.map(async (p) => [p, await p.check()] as const));
  return {
    present: results.filter(([, ok]) => ok).map(([p]) => p.id),
    missing: results.filter(([, ok]) => !ok).map(([p]) => p),
  };
}
