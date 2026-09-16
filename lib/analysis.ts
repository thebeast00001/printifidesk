"use client";

import type { PDFPageProxy } from "pdfjs-dist";

/**
 * Client-side document analysis.
 *
 * Page count and which pages actually carry colour are what the quote is built
 * from, so they are measured here rather than guessed — the whole smart-colour
 * pitch falls apart if the numbers are made up. PDFs and images are measured
 * exactly, and (0039) they are the only kinds taken: a Word or PowerPoint
 * file can't be counted here and can't be printed at the desk without the
 * program that made it, so the student exports it as a PDF first — one
 * step in Word, Google Docs and PowerPoint alike — and every job arrives
 * as a file the desk can open and a count the bill can stand on.
 */

export type FileKind = "PDF" | "IMAGE" | "OTHER";

/** The exact reason a file was turned away, so the message can say what to do instead. */
export type Rejection = "office" | "text" | "other";

export interface Analysis {
  pages: number;
  /** 1-based page numbers that contain colour. */
  colourIndex: number[];
  /** False when the page count is an estimate pending server-side conversion. */
  exact: boolean;
  note?: string;
}

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ANALYSED_PAGES = 400;

/** Above this share of coloured pixels, a page is charged at the colour rate. */
const COLOUR_PIXEL_RATIO = 0.004;
/** Channel spread that counts a pixel as coloured rather than grey. */
const COLOUR_CHANNEL_SPREAD = 24;

export const ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"] as const;

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"];
const OFFICE_EXTENSIONS = [".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp", ".ods", ".pages", ".key"];

export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot);
}

export function kindOf(file: File): FileKind {
  const ext = extensionOf(file.name);
  if (ext === ".pdf" || file.type === "application/pdf") return "PDF";
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.includes(ext)) return "IMAGE";
  return "OTHER";
}

/** Why a file isn't one we take. */
export function rejectionOf(file: File): Rejection {
  const ext = extensionOf(file.name);
  if (OFFICE_EXTENSIONS.includes(ext)) return "office";
  if (ext === ".txt" || ext === ".rtf" || ext === ".md") return "text";
  return "other";
}

/**
 * What the upload is sent as. Browsers report an empty type for some
 * files (HEIC on older Android, anything renamed), and the bucket only
 * takes PDF and images — so the type is settled here, from the extension
 * when the browser has nothing to say.
 */
export function contentTypeOf(file: File): string {
  if (file.type === "application/pdf" || file.type.startsWith("image/")) return file.type;
  switch (extensionOf(file.name)) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    default:
      return "application/octet-stream";
  }
}

export function validate(file: File): string | null {
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_FILE_BYTES) {
    return `Too large — ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`;
  }
  if (kindOf(file) === "OTHER") {
    switch (rejectionOf(file)) {
      case "office":
        return "Save it as a PDF first — File → Save as PDF in Word, or File → Download → PDF in Google Docs — then add the PDF. The desk prints exactly what you see.";
      case "text":
        return "Print it to PDF first (File → Print → Save as PDF), then add the PDF.";
      default:
        return "PDF or a photo (JPG, PNG, WebP, HEIC). Save it as a PDF first, then add that.";
    }
  }
  return null;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */

/** Nothing may leave a file stuck mid-scan; past this we price it as B/W. */
const ANALYSIS_TIMEOUT_MS = 45_000;

export async function analyse(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<Analysis> {
  const kind = kindOf(file);

  if (kind === "PDF") {
    return withTimeout(analysePdf(file, onProgress), {
      pages: estimatePages(file),
      colourIndex: [],
      exact: false,
      note: "Took too long to scan here — we'll count the pages at the counter.",
    });
  }
  // validate() turned everything else away; this is the image path.
  return analyseImage(file);
}

function withTimeout(work: Promise<Analysis>, fallback: Analysis): Promise<Analysis> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ANALYSIS_TIMEOUT_MS);
    work.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** A PDF that couldn't be scanned in time: a rough count so the quote isn't blank, marked as such. */
function estimatePages(file: File) {
  return Math.max(1, Math.round(file.size / 45_000));
}

async function analysePdf(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<Analysis> {
  const pdfjs = await import("pdfjs-dist");

  // pdf.js 6 ships an ES-module worker. Handing it a `workerSrc` string lets
  // pdf.js construct a *classic* Worker, which fails to parse the module and
  // then hangs `getDocument` forever with no error. Constructing the worker
  // here pins `type: "module"` so that can't happen.
  pdfjs.GlobalWorkerOptions.workerPort ??= new Worker("/pdf.worker.min.mjs", {
    type: "module",
  });

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;

  try {
    const pages = doc.numPages;
    const colourIndex: number[] = [];
    const scanLimit = Math.min(pages, MAX_ANALYSED_PAGES);
    let uncheckedImages = 0;

    for (let n = 1; n <= scanLimit; n++) {
      const page = await doc.getPage(n);
      const verdict = await inspectOperators(page, pdfjs.OPS);

      if (verdict === "colour") {
        colourIndex.push(n);
      } else if (verdict === "image") {
        // A raster image's colours aren't in the operator list, so this is the
        // one case that needs pixels. Rasterising is best-effort: it depends on
        // requestAnimationFrame, which a backgrounded tab suspends.
        const raster = await rasterisePage(page);
        if (raster === "colour") colourIndex.push(n);
        else if (raster === "unknown") uncheckedImages++;
      }

      page.cleanup();
      onProgress?.(n, scanLimit);
    }

    const notes: string[] = [];
    if (pages > scanLimit) {
      notes.push(`Colour checked on the first ${scanLimit} pages; the rest bill as black & white.`);
    }
    if (uncheckedImages > 0) {
      notes.push(
        `${uncheckedImages} ${uncheckedImages === 1 ? "page has an image" : "pages have images"} we couldn't check here — billed as black & white and confirmed at the counter.`,
      );
    }

    return {
      pages,
      colourIndex,
      exact: true,
      note: notes.length ? notes.join(" ") : undefined,
    };
  } finally {
    // Release the worker's copy of the file; a 50 MB PDF held open would
    // otherwise sit in memory for the rest of the session.
    void doc.cleanup();
  }
}

type Verdict = "colour" | "mono" | "image" | "unknown";

/**
 * Is this colour operand actually coloured, rather than a shade of grey?
 *
 * pdf.js 6 hands colours over as CSS hex strings ("#d93326"); older builds
 * emit an [r, g, b] triple, in 0–255 or 0–1 depending on the build. All three
 * are accepted so a pdf.js upgrade can't silently turn every page monochrome.
 */
function isColoured(arg: unknown): boolean {
  if (typeof arg === "string") {
    const hex = /^#([0-9a-f]{6})$/i.exec(arg.trim());
    if (!hex) return false;
    const value = parseInt(hex[1], 16);
    return spread((value >> 16) & 255, (value >> 8) & 255, value & 255);
  }

  if (Array.isArray(arg) && arg.length >= 3 && arg.slice(0, 3).every((n) => typeof n === "number")) {
    const [r, g, b] = arg as number[];
    const scale = r <= 1 && g <= 1 && b <= 1 ? 255 : 1;
    return spread(r * scale, g * scale, b * scale);
  }

  return false;
}

function spread(r: number, g: number, b: number) {
  return Math.max(r, g, b) - Math.min(r, g, b) > COLOUR_CHANNEL_SPREAD;
}

/**
 * Reads colour straight out of the page's drawing instructions.
 *
 * pdf.js normalises every colour space to RGB in the operator list, so a
 * coloured chart, heading or highlight shows up as a `setFill/StrokeRGBColor`
 * whose channels diverge. This is an order of magnitude faster than
 * rasterising, needs no canvas, and — unlike `page.render()` — doesn't depend
 * on requestAnimationFrame, so it keeps working in a background tab.
 */
async function inspectOperators(
  page: PDFPageProxy,
  OPS: Record<string, number>,
): Promise<Verdict> {
  let sawImage = false;

  try {
    const { fnArray, argsArray } = await page.getOperatorList();

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];

      if (fn === OPS.setFillRGBColor || fn === OPS.setStrokeRGBColor) {
        const args = argsArray[i] as unknown[];
        if (isColoured(args?.[0]) || isColoured(args)) return "colour";
      } else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintJpegXObject
      ) {
        // Stencil masks (paintImageMaskXObject) paint in the current fill
        // colour, so they're deliberately not counted here.
        sawImage = true;
      }
    }
  } catch {
    return "unknown";
  }

  return sawImage ? "image" : "mono";
}

async function rasterisePage(page: PDFPageProxy): Promise<Verdict> {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "unknown";

    const viewport = page.getViewport({ scale: 0.35 });
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const render = page.render({ canvas, canvasContext: ctx, viewport });
    // rAF is suspended in a hidden tab; give up rather than hang the queue.
    const finished = await Promise.race([
      render.promise.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 4000)),
    ]);
    if (!finished) return "unknown";

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return colourRatio(data) > COLOUR_PIXEL_RATIO ? "colour" : "mono";
  } catch {
    return "unknown";
  }
}

async function analyseImage(file: File): Promise<Analysis> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { pages: 1, colourIndex: [], exact: true };

    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
      pages: 1,
      colourIndex: colourRatio(data) > COLOUR_PIXEL_RATIO ? [1] : [],
      exact: true,
    };
  } catch {
    // HEIC and friends that this browser can't decode.
    return {
      pages: 1,
      colourIndex: [1],
      exact: true,
      note: "This browser can't preview the format, so we've assumed colour.",
    };
  }
}

/** Share of visible pixels whose channels diverge enough to need colour ink. */
function colourRatio(data: Uint8ClampedArray, sampleEvery = 3) {
  let coloured = 0;
  let sampled = 0;
  const stride = 4 * sampleEvery;

  for (let i = 0; i < data.length; i += stride) {
    if (data[i + 3] < 8) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    sampled++;
    if (spread > COLOUR_CHANNEL_SPREAD) coloured++;
  }

  return sampled === 0 ? 0 : coloured / sampled;
}
