import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import { sendWhatsApp, whatsappConfig } from "@/lib/whatsapp";
import { requireSecret } from "@/lib/server/secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drains queued notifications: web push first, WhatsApp where it's configured.
 *
 * Called by a Postgres trigger (pg_net) the moment an order changes status, and
 * safe to poll on a schedule as a backstop. Every row is claimed with
 * `for update skip locked` before sending, so two overlapping calls can't send
 * the same message twice, and the outcome — sent or failed, with the provider's
 * own error — is written back. Nothing is marked delivered that wasn't.
 *
 * Needs the service role key: it reads other people's phone numbers and push
 * keys, which no browser-side key is allowed to do.
 */

interface QueuedRow {
  id: number;
  user_id: string;
  order_id: string | null;
  channel: "whatsapp" | "push";
  to_phone: string | null;
  body: string;
  /** Who it's for: a student's own order, or the desk hearing about a new one. */
  audience: "student" | "desk";
}

interface PushRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The public key the browser subscribed with; null before 0025. */
  vapid_key: string | null;
}

function vapidReady(): boolean {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:printify@example.com",
    publicKey,
    privateKey,
  );
  return true;
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
  const whatsapp = whatsappConfig();
  const pushOn = vapidReady();

  const { data: claimed, error } = await supabase.rpc("claim_notifications", { p_limit: 30 });
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  const rows = (claimed ?? []) as QueuedRow[];
  if (rows.length === 0) return Response.json({ ok: true, claimed: 0, sent: 0, failed: 0 });

  const complete = (id: number, status: string, detail: string | null) =>
    supabase.rpc("complete_notification", { p_id: id, p_status: status, p_detail: detail });

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    /* ---------- web push ---------- */
    if (row.channel === "push") {
      if (!pushOn) {
        await complete(row.id, "failed", "Push is not configured on the server (VAPID keys).");
        failed++;
        continue;
      }

      // A desk row goes only to devices subscribed from the desk site; a
      // student row goes to every device the student has, as it always did.
      const desk = row.audience === "desk";
      let query = supabase
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth, vapid_key")
        .eq("user_id", row.user_id);
      if (desk) query = query.eq("desk", true);
      const { data: subs } = await query;

      const devices = (subs ?? []) as PushRow[];
      if (devices.length === 0) {
        await complete(row.id, "skipped", desk ? "No desk device subscribed." : "No device subscribed.");
        skipped++;
        continue;
      }

      let delivered = 0;
      const problems: string[] = [];

      for (const device of devices) {
        // A subscription made with a different public key can never be
        // signed by this private key — the push service refuses it. Naming
        // the cause beats a 403 that reads like a network blip; it means the
        // two deployments don't share one VAPID pair.
        const ourKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
        if (device.vapid_key && device.vapid_key !== ourKey) {
          problems.push("subscribed with a different VAPID key — every deployment must share one pair");
          continue;
        }
        try {
          await webpush.sendNotification(
            { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
            JSON.stringify(
              desk
                ? {
                    // The desk's alert: its own mark, the queue as the target,
                    // and it stays on screen until someone looks at it — a
                    // counter shouldn't miss an order because a phone dimmed.
                    title: "Printify Desk",
                    body: row.body,
                    tag: row.order_id ? `desk-order-${row.order_id}` : "printify-desk",
                    url: "/operator",
                    icon: "/desk-icon-192.png",
                    requireInteraction: true,
                  }
                : {
                    title: "Printify",
                    body: row.body,
                    tag: row.order_id ? `order-${row.order_id}` : "printify",
                    url: "/orders",
                  },
            ),
          );
          delivered++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          // 404/410 mean the browser threw the subscription away. Keeping it
          // would fail forever, so it's removed rather than retried.
          if (status === 404 || status === 410) {
            await supabase.from("push_subscriptions").delete().eq("id", device.id);
            problems.push("subscription expired, removed");
          } else {
            problems.push(e instanceof Error ? e.message : `push failed (${status})`);
          }
        }
      }

      if (delivered > 0) {
        sent++;
        await complete(row.id, "sent", `${delivered} device${delivered === 1 ? "" : "s"}`);
      } else {
        failed++;
        await complete(row.id, "failed", problems.join("; ") || "No device accepted it.");
      }
      continue;
    }

    /* ---------- whatsapp ---------- */
    if (!whatsapp) {
      await complete(row.id, "failed", "WhatsApp is not configured on the server.");
      failed++;
      continue;
    }
    if (!row.to_phone) {
      await complete(row.id, "skipped", "No phone number saved.");
      skipped++;
      continue;
    }

    const result = await sendWhatsApp(whatsapp, row.to_phone, row.body);
    if (result.ok) {
      sent++;
      await complete(row.id, "sent", result.providerId);
    } else {
      failed++;
      await complete(row.id, "failed", result.detail);
    }
  }

  return Response.json({ ok: failed === 0, claimed: rows.length, sent, failed, skipped });
}

/** Readiness check — tells you which half of the setup is missing. */
/**
 * `GET ?run=1` drains the queue the same way POST does — Vercel Cron can
 * only GET. Without `run`, it reports what's configured.
 */
export async function GET(request: Request) {
  const denied = requireSecret(request);
  if (denied) return denied;
  if (new URL(request.url).searchParams.get("run") === "1") return POST(request);
  return Response.json({
    webhookSecret: Boolean(process.env.NOTIFY_WEBHOOK_SECRET),
    serviceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    whatsapp: Boolean(whatsappConfig()),
    webPush: Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  });
}
