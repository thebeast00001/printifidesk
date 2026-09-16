import { callerId, fail, refuseCrossOrigin, serviceClient } from "@/lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// LibreOffice takes a few seconds; a converter waking from sleep can take more.
export const maxDuration = 60;

/**
 * Turns an office file the student just uploaded into a PDF (0041).
 *
 * The converter is Gotenberg — LibreOffice behind an HTTP API — running
 * wherever CONVERT_URL points (a container you host; Vercel can't run
 * LibreOffice itself). The flow keeps the file inside Printify's own
 * storage: the original is read with the service key, posted to the
 * converter, the PDF written back under the same folder and the same
 * document id, and the original removed. The row then points at the PDF;
 * the browser measures it and writes the exact counts. Nothing about
 * pricing happens here.
 *
 * Only the student who owns the document may ask, only for their own
 * office files, and only before the document is on an order.
 */

const OFFICE_EXT = /\.(docx?|pptx?|xlsx?|od[tps]|rtf|txt)$/i;

export async function POST(request: Request) {
  const foreign = await refuseCrossOrigin(request);
  if (foreign) return foreign;

  const target = (process.env.CONVERT_URL ?? "").replace(/\/+$/, "");
  if (!target) return fail("This deployment has no converter — save the file as a PDF and add that.", 503);

  const userId = await callerId();
  if (!userId) return fail("Sign in first", 401);
  const supabase = serviceClient();
  if (!supabase) return fail("SUPABASE_SERVICE_ROLE_KEY is not set.", 503);

  const body = (await request.json().catch(() => null)) as { documentId?: string } | null;
  const documentId = body?.documentId;
  if (!documentId || !/^[0-9a-f-]{36}$/i.test(documentId)) return fail("Which file?");

  const { data: doc } = await supabase
    .from("documents")
    .select("id, user_id, name, storage_path, kind")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc || doc.user_id !== userId) return fail("That file isn't yours.", 404);
  if (!OFFICE_EXT.test(doc.name) || !OFFICE_EXT.test(doc.storage_path)) return fail("That file doesn't need converting.");
  const { count } = await supabase.from("order_items").select("id", { count: "exact", head: true }).eq("document_id", doc.id);
  if ((count ?? 0) > 0) return fail("That file is already on an order.");

  // The original, from storage.
  const { data: blob, error: readError } = await supabase.storage.from("documents").download(doc.storage_path);
  if (readError || !blob) return fail("Couldn't read the file from storage.", 502);

  // To LibreOffice, and back as a PDF.
  const form = new FormData();
  form.append("files", blob, doc.name);
  const headers: Record<string, string> = {};
  if (process.env.CONVERT_USER && process.env.CONVERT_PASSWORD) {
    headers.authorization = `Basic ${Buffer.from(`${process.env.CONVERT_USER}:${process.env.CONVERT_PASSWORD}`).toString("base64")}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  let pdf: ArrayBuffer;
  try {
    const res = await fetch(`${target}/forms/libreoffice/convert`, { method: "POST", body: form, headers, signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      return fail(`The converter refused it (${res.status})${text ? `: ${text}` : ""}`, 502);
    }
    pdf = await res.arrayBuffer();
  } catch (e) {
    return fail(e instanceof Error && e.name === "AbortError" ? "The converter took too long." : "Couldn't reach the converter.", 504);
  } finally {
    clearTimeout(timer);
  }
  if (pdf.byteLength < 100 || new TextDecoder().decode(pdf.slice(0, 5)) !== "%PDF-") return fail("The converter didn't return a PDF.", 502);

  // The PDF goes where the original was, under the same document id; the
  // path keeps the student's folder as the storage policies require.
  const pdfPath = doc.storage_path.replace(OFFICE_EXT, "") + ".pdf";
  const pdfName = doc.name.replace(OFFICE_EXT, "") + ".pdf";
  const { error: writeError } = await supabase.storage
    .from("documents")
    .upload(pdfPath, Buffer.from(pdf), { contentType: "application/pdf", upsert: true });
  if (writeError) return fail(`Couldn't store the PDF: ${writeError.message}`, 502);

  const { error: rowError } = await supabase
    .from("documents")
    .update({ storage_path: pdfPath, name: pdfName, kind: "PDF", size_bytes: pdf.byteLength, pages_exact: false })
    .eq("id", doc.id);
  if (rowError) return fail(`Converted, but the row didn't update: ${rowError.message}`, 500);

  // The original has done its job.
  if (pdfPath !== doc.storage_path) await supabase.storage.from("documents").remove([doc.storage_path]);

  return Response.json({ ok: true, storage_path: pdfPath, name: pdfName, size_bytes: pdf.byteLength });
}
