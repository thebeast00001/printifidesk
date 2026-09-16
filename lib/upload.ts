"use client";

import { DOCUMENTS_BUCKET, SUPABASE_KEY, SUPABASE_URL, getSupabase } from "./supabase/client";
import { contentTypeOf, type Analysis } from "./analysis";

/**
 * Uploads go over XHR rather than supabase-js so the progress bar reflects
 * bytes actually on the wire. On flaky campus wifi a stalled upload that
 * *looks* finished is worse than a slow one that's honest.
 */
export function uploadToStorage({
  file,
  path,
  accessToken,
  onProgress,
  signal,
}: {
  file: File;
  path: string;
  accessToken: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${SUPABASE_URL}/storage/v1/object/${DOCUMENTS_BUCKET}/${encodeURI(path)}`;

    xhr.open("POST", url, true);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("apikey", SUPABASE_KEY);
    xhr.setRequestHeader("x-upsert", "true");
    // Settled from the extension when the browser has no type: the bucket
    // takes PDF and images only (0039), and a blank type would be refused.
    xhr.setRequestHeader("Content-Type", contentTypeOf(file));

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      reject(new Error(storageError(xhr.status, xhr.responseText)));
    };

    xhr.onerror = () => reject(new Error("Network dropped during upload."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));

    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

function storageError(status: number, body: string): string {
  if (status === 404) {
    return `Storage bucket "${DOCUMENTS_BUCKET}" doesn't exist yet. Run supabase/migrations/0001_init.sql.`;
  }
  if (status === 401 || status === 403) {
    return "Storage rejected the upload. Check the bucket policies in 0001_init.sql.";
  }
  if (status === 413) return "File is larger than the bucket's size limit.";

  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string };
    if (parsed.message || parsed.error) return parsed.message ?? parsed.error ?? "Upload failed.";
  } catch {
    /* fall through to the generic message */
  }
  return `Upload failed (${status}).`;
}

export interface DocumentRow {
  id: string;
  name: string;
  kind: string;
  storage_path: string;
  size_bytes: number;
  pages: number;
  colour_pages: number;
  colour_index: number[];
  pages_exact: boolean;
  created_at: string;
}

export async function recordDocument(params: {
  id: string;
  userId: string;
  file: File;
  kind: string;
  path: string;
  analysis: Analysis;
}): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("documents").insert({
    id: params.id,
    user_id: params.userId,
    name: params.file.name,
    kind: params.kind,
    storage_path: params.path,
    size_bytes: params.file.size,
    pages: params.analysis.pages,
    colour_pages: params.analysis.colourIndex.length,
    colour_index: params.analysis.colourIndex,
    pages_exact: params.analysis.exact,
  });

  if (error) throw new Error(tableError(error.message));
}

/** Asks the server to turn an office file into a PDF (0041). Returns the PDF's row fields. */
export async function convertDocument(documentId: string): Promise<{ storage_path: string; name: string; size_bytes: number }> {
  const res = await fetch("/api/convert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documentId }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; storage_path?: string; name?: string; size_bytes?: number };
  if (!res.ok || !body.ok || !body.storage_path || !body.name) throw new Error(body.error ?? "The converter didn't answer.");
  return { storage_path: body.storage_path, name: body.name, size_bytes: Number(body.size_bytes ?? 0) };
}

/** The exact counts, once the PDF has been measured here (0041). The student's own row, before it's on an order. */
export async function setDocumentAnalysis(documentId: string, pages: number, colourIndex: number[]): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.rpc("set_document_analysis", { p_document: documentId, p_pages: pages, p_colour_index: colourIndex });
  if (error) throw new Error(error.message);
}

export async function listDocuments(): Promise<DocumentRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(60);

  if (error) return [];
  return (data ?? []) as DocumentRow[];
}

export async function deleteDocument(id: string, storagePath: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath]);
  await supabase.from("documents").delete().eq("id", id);
}

function tableError(message: string): string {
  if (message.includes("does not exist") || message.includes("schema cache")) {
    return "The documents table doesn't exist yet. Run supabase/migrations/0001_init.sql.";
  }
  return message;
}

/** Storage keys the RLS policies can read an owner from: `<user id>/<file>`. */
export function storagePathFor(userId: string, documentId: string, fileName: string) {
  const safe = fileName
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "_")
    .slice(-80);
  return `${userId}/${documentId}-${safe}`;
}
