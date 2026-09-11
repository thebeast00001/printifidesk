"use client";

/**
 * Page thumbnails for the review sheet.
 *
 * Rendering is the only way to *show* a page — the operator-list trick used for
 * colour detection tells you what's drawn, not what it looks like. So this does
 * rasterise, but lazily: only the pages someone actually scrolls to, one at a
 * time, cached per file for the life of the tab.
 *
 * `page.render()` schedules through requestAnimationFrame, which a hidden tab
 * suspends, so every render is raced against a timeout rather than left to hang.
 */

const RENDER_TIMEOUT_MS = 8000;

/** Object URLs keyed `${fileId}:${pageNumber}`, revoked when the file is dropped. */
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();
/** The parsed document per file, so a 200-page PDF is opened once. */
const documents = new Map<string, Promise<PdfDoc>>();

type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => { width: number; height: number };
    render: (o: Record<string, unknown>) => { promise: Promise<void>; cancel: () => void };
    cleanup: () => void;
  }>;
};

async function openDocument(fileId: string, file: File): Promise<PdfDoc> {
  let existing = documents.get(fileId);
  if (existing) return existing;

  existing = (async () => {
    const pdfjs = await import("pdfjs-dist");
    // pdf.js 6 ships an ES-module worker; a string workerSrc makes it build a
    // classic Worker, which fails to parse and then hangs forever.
    pdfjs.GlobalWorkerOptions.workerPort ??= new Worker("/pdf.worker.min.mjs", {
      type: "module",
    });
    const buffer = await file.arrayBuffer();
    return (await pdfjs.getDocument({ data: buffer }).promise) as unknown as PdfDoc;
  })();

  documents.set(fileId, existing);
  return existing;
}

export async function pageThumbnail(
  fileId: string,
  file: File,
  pageNumber: number,
  width = 220,
): Promise<string | null> {
  const key = `${fileId}:${pageNumber}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    try {
      const doc = await openDocument(fileId, file);
      const page = await doc.getPage(pageNumber);

      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const task = page.render({ canvas, canvasContext: ctx, viewport });
      const finished = await Promise.race([
        task.promise.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), RENDER_TIMEOUT_MS)),
      ]);

      page.cleanup();
      if (!finished) {
        task.cancel();
        return null;
      }

      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.75));
      if (!blob) return null;

      const url = URL.createObjectURL(blob);
      cache.set(key, url);
      return url;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, work);
  return work;
}

/** Frees the object URLs and the parsed document for one file. */
export function releaseThumbnails(fileId: string) {
  for (const [key, url] of cache) {
    if (key.startsWith(`${fileId}:`)) {
      URL.revokeObjectURL(url);
      cache.delete(key);
    }
  }
  documents.delete(fileId);
}
