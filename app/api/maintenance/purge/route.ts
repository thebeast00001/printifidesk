import { createClient } from "@supabase/supabase-js";
import { requireSecret } from "@/lib/server/secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deletes documents whose retention window has passed.
 *
 * `purge_at` is stamped six hours after an order is collected (trigger in
 * 0011). Removing the row alone isn't enough — the object has to go through the
 * storage API or the file stays in the bucket — which is why this is a route
 * with the service key rather than a SQL job.
 *
 * Point a Supabase cron or any scheduler at it:
 *   POST /api/maintenance/purge   header: x-notify-secret: <NOTIFY_WEBHOOK_SECRET>
 */

interface Expired {
  id: string;
  storage_path: string;
}

export async function POST(request: Request) {
  const denied = requireSecret(request);
  if (denied) return denied;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return Response.json(
      { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY is not set." },
      { status: 503 },
    );
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Housekeeping first (0039): every desk's unpaid orders past their window
  // and ready ones nobody collected. The files of what's just been marked
  // unclaimed get their purge stamp from the trigger; they go next run.
  let swept = 0;
  const sweep = await supabase.rpc("sweep_all_orders");
  if (!sweep.error) swept = Number(sweep.data ?? 0);

  const { data, error } = await supabase
    .from("documents")
    .select("id, storage_path")
    .not("purge_at", "is", null)
    .lte("purge_at", new Date().toISOString())
    .limit(200);

  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  const expired = (data ?? []) as Expired[];
  if (expired.length === 0) return Response.json({ ok: true, removed: 0, swept });

  // Storage first: a deleted row with a surviving object is an orphan nothing
  // will ever clean up, whereas a surviving row with no object is self-healing.
  // The print bundle (0044) sits beside the document under the same name
  // plus ".print.pdf"; it goes with it. A missing sibling isn't an error.
  const { error: storageError } = await supabase.storage
    .from("documents")
    .remove(expired.flatMap((d) => [d.storage_path, `${d.storage_path}.print.pdf`]));

  if (storageError) {
    return Response.json(
      { ok: false, error: `Storage: ${storageError.message}`, removed: 0 },
      { status: 500 },
    );
  }

  const { error: rowError } = await supabase
    .from("documents")
    .delete()
    .in("id", expired.map((d) => d.id));

  if (rowError) {
    return Response.json(
      { ok: false, error: `Rows: ${rowError.message}`, removed: expired.length },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, removed: expired.length, swept });
}

/**
 * How much is currently waiting to be purged — or, with `?run=1`, the purge
 * itself, since Vercel Cron can only GET.
 */
export async function GET(request: Request) {
  const denied = requireSecret(request);
  if (denied) return denied;
  if (new URL(request.url).searchParams.get("run") === "1") return POST(request);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return Response.json({ configured: false });

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { count } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .not("purge_at", "is", null)
    .lte("purge_at", new Date().toISOString());

  return Response.json({ configured: true, due: count ?? 0 });
}
