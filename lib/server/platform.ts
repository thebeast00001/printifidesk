import "server-only";
import { createClient } from "@supabase/supabase-js";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * The payout day, for a server-rendered page (the terms for desks). Read
 * with the anon key — `platform_settings` is public by policy — and never
 * cached across requests, so the page says what the admin set, not what
 * it said at build time. Null when the project hasn't run 0040 or can't
 * be reached; the page then points at Takings instead of naming a day.
 */
export async function payoutWeekdayName(): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  try {
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.from("platform_settings").select("payout_weekday").eq("id", true).maybeSingle();
    if (error || !data) return null;
    const n = Number((data as { payout_weekday?: number }).payout_weekday);
    return n >= 1 && n <= 7 ? WEEKDAYS[n - 1] : null;
  } catch {
    return null;
  }
}
