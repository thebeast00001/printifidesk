import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { callerId, fail, isStaffOf, refuseCrossOrigin, serviceClient } from "@/lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A 50 MB PDF takes a few seconds to load and copy.
export const maxDuration = 60;

/**
 * The print bundle (0044): the file the desk opens to print, with a cover
 * sheet in front of it — the token in big type, the student's first name,
 * pages and settings, the shelf slot, what's owed in cash, a QR to file
 * and find the pile by. The document itself is untouched: the bundle is
 * the cover page followed by the pages exactly as uploaded (a photo goes
 * on a page of its own).
 *
 * Only the desk's staff, for a live order at their desk — the same check
 * `claim_document_access` makes, which the browser has just called (that
 * is what writes the access log). The bundle is written beside the
 * document in storage and handed back as a short-lived signed link, the
 * way the converter does it: a response body is capped at a few MB here
 * and a bundle isn't.
 *
 * The QR says `printify:cover:<token>:<desk>` — the token and the desk's
 * first eight hex characters, nothing else. Never the handover secret: a
 * cover sheet left on a counter must prove nothing.
 */

const A4 = { w: 595.28, h: 841.89 };
const INK = rgb(0.09, 0.09, 0.1);
const MUTED = rgb(0.45, 0.45, 0.47);

export async function POST(request: Request) {
  const foreign = await refuseCrossOrigin(request);
  if (foreign) return foreign;
  const userId = await callerId();
  if (!userId) return fail("Sign in first", 401);
  const supabase = serviceClient();
  if (!supabase) return fail("SUPABASE_SERVICE_ROLE_KEY is not set.", 503);

  const body = (await request.json().catch(() => null)) as { itemId?: string } | null;
  const itemId = body?.itemId;
  if (!itemId || !/^[0-9a-f-]{36}$/i.test(itemId)) return fail("Which file?");

  const { data: item } = await supabase
    .from("order_items")
    .select("id, name, pages, colour_pages, config, ordinal, document_id, order_id")
    .eq("id", itemId)
    .maybeSingle();
  if (!item?.document_id) return fail("That item has no stored file.", 404);

  const { data: order } = await supabase
    .from("orders")
    .select("id, user_id, operator_id, token, status, total, pages, colour_pages, config, shelf_slot, pay_at_pickup, payment_taken_at, gateway_paid_at, payment_method, created_at, pickup_mode, pickup_at")
    .eq("id", item.order_id)
    .maybeSingle();
  if (!order) return fail("No such order.", 404);
  if (!(await isStaffOf(supabase, userId, order.operator_id))) return fail("Not your desk.", 403);
  if (!["placed", "queued", "printing", "finishing", "ready"].includes(order.status)) return fail("This order isn't live.");

  const [{ data: doc }, { data: operator }, { data: profile }, { count: itemCount }] = await Promise.all([
    supabase.from("documents").select("id, name, storage_path, kind").eq("id", item.document_id).maybeSingle(),
    supabase.from("operators").select("id, name, short_name, currency, cover_sheet").eq("id", order.operator_id).maybeSingle(),
    supabase.from("profiles").select("name").eq("id", order.user_id).maybeSingle(),
    supabase.from("order_items").select("id", { count: "exact", head: true }).eq("order_id", order.id),
  ]);
  if (!doc) return fail("The file is no longer stored.", 404);
  if (!operator) return fail("No such desk.", 404);

  const { data: blob, error: readError } = await supabase.storage.from("documents").download(doc.storage_path);
  if (readError || !blob) return fail("Couldn't read the file from storage.", 502);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  let bundle: PDFDocument;
  try {
    bundle = await PDFDocument.create();
    const font = await bundle.embedFont(StandardFonts.HelveticaBold);
    const body = await bundle.embedFont(StandardFonts.Helvetica);
    const mono = await bundle.embedFont(StandardFonts.Courier);

    // The cover.
    const cover = bundle.addPage([A4.w, A4.h]);
    const config = { ...order.config, ...item.config } as Record<string, unknown>;
    const copies = Math.max(1, Number(config.copies ?? 1));
    const sides = config.sides === "single" ? "one side" : "both sides";
    const colour = config.colour === "full" ? "colour" : config.colour === "bw" ? "B/W" : item.colour_pages > 0 ? `${item.colour_pages} colour` : "B/W";
    const binding = config.binding === "staple" ? " · stapled" : "";
    const firstName = (profile?.name ?? "").trim().split(/\s+/)[0] || "Student";
    const initial = ((profile?.name ?? "").trim().split(/\s+/)[1] ?? "").charAt(0);
    const cashDue = order.pay_at_pickup && !order.payment_taken_at && !order.gateway_paid_at;
    const paid = Boolean(order.payment_taken_at || order.gateway_paid_at);
    const cur = (operator.currency ?? "₹").trim();
    // Standard fonts have no ₹; the sheet says Rs.
    const amount = `${cur === "₹" ? "Rs " : cur}${Number(order.total).toFixed(2).replace(/\.00$/, "")}`;
    const deskName = operator.short_name?.trim() || operator.name;
    const token = order.token ?? "—";
    const deskHex = order.operator_id.replace(/-/g, "").slice(0, 8).toUpperCase();
    const placed = new Date(order.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    const fileLine = (itemCount ?? 1) > 1 ? `${item.name}  (file ${item.ordinal + 1} of ${itemCount})` : item.name;

    // Token, four centimetres tall, top left.
    cover.drawText(token, { x: 48, y: A4.h - 48 - 118, size: 128, font, color: INK });
    // QR, top right: token + desk. Nothing a found sheet could prove with.
    const qrPng = await QRCode.toBuffer(`printify:cover:${token}:${deskHex}`, { type: "png", margin: 1, width: 360, errorCorrectionLevel: "M" });
    const qr = await bundle.embedPng(qrPng);
    cover.drawImage(qr, { x: A4.w - 48 - 150, y: A4.h - 48 - 150, width: 150, height: 150 });
    text(cover, "scan to file · scan to find", mono, 8.5, A4.w - 48 - 150, A4.h - 48 - 150 - 12, MUTED);

    let y = A4.h - 48 - 118 - 44;
    text(cover, `${firstName}${initial ? ` ${initial}.` : ""}`, font, 34, 48, y, INK);
    y -= 30;
    text(cover, `${item.pages} ${item.pages === 1 ? "page" : "pages"} · ${colour} · ${sides}${binding}${copies > 1 ? ` · ${copies} copies` : ""}`, body, 15, 48, y, INK);
    y -= 22;
    text(cover, fileLine, body, 12, 48, y, MUTED, A4.w - 96);

    // The money, in a box: what the counter must do at the handover.
    y -= 44;
    const money = cashDue ? `CASH ${amount} AT PICKUP` : paid ? `PAID${order.payment_method === "gateway" ? " ONLINE" : ""} · ${amount}` : `UNPAID · ${amount}`;
    cover.drawRectangle({ x: 48, y: y - 12, width: A4.w - 96, height: 40, borderColor: INK, borderWidth: cashDue ? 2 : 1, color: cashDue ? rgb(0.96, 0.93, 0.85) : rgb(0.97, 0.97, 0.96) });
    text(cover, money, font, 17, 60, y, INK);

    // Where it lives, and when it was ordered.
    y -= 52;
    if (order.shelf_slot) {
      text(cover, "SHELF", mono, 9, 48, y + 26, MUTED);
      text(cover, order.shelf_slot, font, 40, 48, y - 8, INK);
    }
    const right = (label: string, value: string, yy: number) => {
      text(cover, label, mono, 9, 300, yy + 14, MUTED);
      text(cover, value, body, 13, 300, yy, INK);
    };
    right("DESK", deskName, y + 14);
    right("ORDERED", placed, y - 20);
    if (order.pickup_mode === "scheduled" && order.pickup_at) {
      right("PICKUP", new Date(order.pickup_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }), y - 54);
    }

    // The foot: whose sheet this is, and that it's discardable.
    text(cover, `Printifi · printifi.store · order ${order.id.slice(0, 8)}`, mono, 8.5, 48, 40, MUTED);
    text(cover, "Cover sheet — keep with the job until it's handed over; the student may discard it.", body, 9, 48, 28, MUTED);

    // Then the document, page for page.
    if (doc.kind === "PDF" || /\.pdf$/i.test(doc.storage_path)) {
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await bundle.copyPages(src, src.getPageIndices());
      for (const p of pages) bundle.addPage(p);
    } else {
      // A photo: on a page of its own, fitted, upright. HEIC/WebP can't be
      // embedded by pdf-lib; those go without a cover (the desk opens the original).
      const image = /\.(jpe?g)$/i.test(doc.storage_path) ? await bundle.embedJpg(bytes) : /\.png$/i.test(doc.storage_path) ? await bundle.embedPng(bytes) : null;
      if (!image) return Response.json({ ok: false, error: "This photo format can't carry a cover — open the original.", uncoverable: true }, { status: 415 });
      const page = bundle.addPage([A4.w, A4.h]);
      const scale = Math.min((A4.w - 72) / image.width, (A4.h - 72) / image.height, 1e9);
      const w = image.width * scale, h = image.height * scale;
      page.drawImage(image, { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h });
    }
  } catch (e) {
    return fail(e instanceof Error ? `Couldn't build the bundle: ${e.message}` : "Couldn't build the bundle.", 502);
  }

  const out = await bundle.save();
  const path = `${doc.storage_path}.print.pdf`;
  const { error: writeError } = await supabase.storage
    .from("documents")
    .upload(path, Buffer.from(out), { contentType: "application/pdf", upsert: true });
  if (writeError) return fail(`Couldn't store the bundle: ${writeError.message}`, 502);
  const { data: signed, error: signError } = await supabase.storage.from("documents").createSignedUrl(path, 300);
  if (signError || !signed?.signedUrl) return fail("Couldn't sign the bundle.", 502);
  return Response.json({ ok: true, url: signed.signedUrl, name: `${order.token ?? "job"} ${doc.name}.pdf` });
}

function text(page: PDFPage, s: string, font: PDFFont, size: number, x: number, y: number, color = INK, maxWidth?: number) {
  // Standard fonts know WinAnsi only; anything outside it becomes a plain mark.
  let safe = s.replace(/[^\x20-\x7E -ÿ]/g, (ch) => (ch === "₹" ? "Rs" : ch === "·" ? "-" : ch === "—" ? "-" : "?"));
  if (maxWidth && font.widthOfTextAtSize(safe, size) > maxWidth) {
    let cut = safe;
    while (cut.length > 4 && font.widthOfTextAtSize(cut + "...", size) > maxWidth) cut = cut.slice(0, -1);
    safe = cut + "...";
  }
  page.drawText(safe, { x, y, size, font, color });
}
