"use client";

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

/**
 * Client-side document analysis.
 *
 * Page count and which pages actually carry colour are what the quote is built
 * from, so they are measured here rather than guessed — the whole smart-colour
 * pitch falls apart if the numbers are made up. PDFs and images are measured
 * exactly. Office files (Word, PowerPoint, Excel, text) are taken when the
 * deployment has a converter (0041: NEXT_PUBLIC_CONVERTS_OFFICE, with
 * CONVERT_URL on the server): they go up as they are, the server turns them
 * into a PDF, and that PDF is measured here exactly like an uploaded one —
 * so the desk still only ever opens PDFs and photos. Without a converter
 * they're turned away with the one-step way out.
 */

export type FileKind = "PDF" | "IMAGE" | "OFFICE" | "OTHER";

/** Whether this deployment can turn office files into PDFs (set alongside CONVERT_URL). */
export const CONVERTS_OFFICE = process.env.NEXT_PUBLIC_CONVERTS_OFFICE === "1";

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

/**
 * Every page is checked for colour — a 600-page file is billed on what's in
 * it, not on a sample of it. Two guards keep a phone from sitting on a scan
 * forever: a page that gives no answer for STALL_MS means the worker is
 * stuck (a broken page, a tab the browser has frozen), and past
 * SCAN_BUDGET_MS in total the scan stops where it is. Either way the page
 * count is exact — it's known the moment the file opens — and only the
 * pages not reached bill as black & white, which the desk can correct.
 */
const STALL_MS = 30_000;
const SCAN_BUDGET_MS = 4 * 60_000;
/** Pixels sampled from one image to judge its colour — plenty for a scan, cheap for a photo. */
const IMAGE_SAMPLE_PIXELS = 24_000;

/** Above this share of coloured pixels, a page is charged at the colour rate. */
const COLOUR_PIXEL_RATIO = 0.004;
/** Channel spread that counts a pixel as coloured rather than grey. */
const COLOUR_CHANNEL_SPREAD = 24;

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"];
/** What LibreOffice turns into a PDF for us. Apple's Pages/Keynote aren't among them. */
export const OFFICE_EXTENSIONS = [".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp", ".ods", ".rtf", ".txt"];

export const ACCEPTED_EXTENSIONS: readonly string[] = CONVERTS_OFFICE
  ? [".pdf", ...IMAGE_EXTENSIONS, ...OFFICE_EXTENSIONS]
  : [".pdf", ...IMAGE_EXTENSIONS];

export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot);
}

export function kindOf(file: File): FileKind {
  const ext = extensionOf(file.name);
  if (ext === ".pdf" || file.type === "application/pdf") return "PDF";
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.includes(ext)) return "IMAGE";
  if (OFFICE_EXTENSIONS.includes(ext)) return "OFFICE";
  return "OTHER";
}

/** Why a file isn't one we take. */
export function rejectionOf(file: File): Rejection {
  const ext = extensionOf(file.name);
  if ([".pages", ".key", ".numbers", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp", ".ods"].includes(ext)) return "office";
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
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".odt":
      return "application/vnd.oasis.opendocument.text";
    case ".odp":
      return "application/vnd.oasis.opendocument.presentation";
    case ".ods":
      return "application/vnd.oasis.opendocument.spreadsheet";
    case ".rtf":
      return "application/rtf";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

export function validate(file: File): string | null {
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_FILE_BYTES) {
    return `Too large — ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`;
  }
  const kind = kindOf(file);
  if (kind === "OFFICE" && !CONVERTS_OFFICE) {
    return "Save it as a PDF first — File → Save as PDF in Word, or File → Download → PDF in Google Docs — then add the PDF. The desk prints exactly what you see.";
  }
  if (kind === "OTHER") {
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

/**
 * How long opening the file may take: pdf.js copies the whole 50 MB into
 * its worker and parses the page tree. Nothing may leave a file stuck at
 * that stage; the scan that follows keeps its own time (STALL_MS,
 * SCAN_BUDGET_MS) and can't hang because the count is in hand by then.
 */
const OPEN_TIMEOUT_MS = 60_000;

export async function analyse(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<Analysis> {
  const kind = kindOf(file);

  if (kind === "PDF") {
    try {
      return await analysePdf(file, onProgress);
    } catch {
      // Unreadable here — broken, encrypted, or the worker never answered.
      // A rough count marked as one; the desk confirms it.
      return {
        pages: estimatePages(file),
        colourIndex: [],
        exact: false,
        note: "Couldn't read this PDF here — the page count is confirmed at the counter.",
      };
    }
  }
  if (kind === "IMAGE") return analyseImage(file);

  // An office file: a rough count so the quote isn't blank while the server
  // turns it into a PDF, which is then measured exactly (use-uploader).
  return {
    pages: estimatePages(file),
    colourIndex: [],
    exact: false,
    note: "Converting to PDF — the page count is confirmed in a moment.",
  };
}


const TIMED_OUT = Symbol("timed out");

/** The work's result, or TIMED_OUT once `ms` have passed without one. A rejection is the caller's to handle. */
function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    work.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A rough count — a PDF that couldn't be read here, or an office file awaiting conversion — marked as such. */
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
  const doc = await within(pdfjs.getDocument({ data: buffer }).promise, OPEN_TIMEOUT_MS);
  if (doc === TIMED_OUT) throw new Error("The PDF didn't open in time.");

  try {
    // Exact from here on, whatever the colour scan manages after it.
    const pages = doc.numPages;
    const colourIndex: number[] = [];
    let uncheckedImages = 0;
    let checked = 0;
    const started = Date.now();

    for (let n = 1; n <= pages; n++) {
      if (Date.now() - started > SCAN_BUDGET_MS) break;
      const verdict = await within(judgePage(doc, n, pdfjs.OPS), STALL_MS);
      if (verdict === TIMED_OUT) break;

      if (verdict === "colour") colourIndex.push(n);
      else if (verdict === "unknown") uncheckedImages++;

      checked = n;
      onProgress?.(n, pages);
    }

    const notes: string[] = [];
    if (checked < pages) {
      notes.push(
        `Colour checked on the first ${checked} pages; the rest bill as black & white, and the desk confirms.`,
      );
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
    // Release what the worker decoded — fonts, images, the page tree's
    // caches — which for 600 pages would otherwise sit in memory for the
    // rest of the session. (Not `destroy`: the worker is shared with the
    // thumbnails, and destroying through a shared port can strand them.)
    // A page still mid-parse after a stall makes this refuse; that's
    // nothing to report.
    doc.cleanup().catch(() => {});
  }
}

/** What a page comes to; "image" is the in-between state of a page whose colour is inside its pictures. */
type PageVerdict = "colour" | "mono" | "unknown";
type Verdict = PageVerdict | "image";

/**
 * One page's verdict. Colour in the drawing instructions settles it at once;
 * a page whose colour is inside its images has those images read; only an
 * image that can't be read has the page drawn. A page pdf.js can't parse is
 * "unknown" — counted, billed as B/W, confirmed at the counter — rather than
 * the end of the scan.
 */
async function judgePage(doc: PDFDocumentProxy, n: number, OPS: Record<string, number>): Promise<PageVerdict> {
  let page: PDFPageProxy | null = null;
  try {
    page = await doc.getPage(n);
    const { verdict, images } = await inspectOperators(page, OPS);
    if (verdict !== "image") return verdict;

    const fromImages = await inspectImages(page, images);
    return fromImages === "unknown" ? await rasterisePage(page) : fromImages;
  } catch {
    return "unknown";
  } finally {
    page?.cleanup();
  }
}

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
): Promise<{ verdict: Verdict; images: unknown[] }> {
  // What each image operator was handed: the name of a decoded image held
  // on the page, or (inline) the image itself. Read by `inspectImages`.
  const images: unknown[] = [];

  try {
    const { fnArray, argsArray } = await page.getOperatorList();

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];

      if (fn === OPS.setFillRGBColor || fn === OPS.setStrokeRGBColor) {
        const args = argsArray[i] as unknown[];
        if (isColoured(args?.[0]) || isColoured(args)) return { verdict: "colour", images };
      } else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintImageXObjectRepeat ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintJpegXObject
      ) {
        // Stencil masks (paintImageMaskXObject) paint in the current fill
        // colour, so they're deliberately not counted here.
        images.push((argsArray[i] as unknown[])?.[0]);
      }
    }
  } catch {
    return { verdict: "unknown", images };
  }

  return { verdict: images.length ? "image" : "mono", images };
}

/**
 * The colour of a page's images, read from the images themselves.
 *
 * Building the operator list already decoded them; pdf.js holds each on the
 * page (or on the document, for an image many pages share) as a bitmap, or
 * as bytes with a kind. A 1-bit greyscale image — most scans — is mono
 * without a look; anything else is sampled at a few thousand pixels. That
 * needs no page render and no animation frame, so it runs at the same
 * speed in a background tab as in front, which is how a 600-page scan is
 * judged in seconds on a phone. What can't be read says "unknown", and the
 * page is drawn instead.
 */
async function inspectImages(page: PDFPageProxy, images: unknown[]): Promise<PageVerdict> {
  // Waited for together: a page of many small images shouldn't pay the
  // wait for each in turn.
  const decoded = await Promise.all(images.map((ref) => decodedImage(page, ref)));
  let sawUnknown = false;
  for (const image of decoded) {
    const judged = image ? imageColour(image) : "unknown";
    if (judged === "colour") return "colour";
    if (judged === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "mono";
}

/** What pdf.js's worker hands over for one image (`PDFImage.createImageData`). */
interface DecodedImage {
  width?: number;
  height?: number;
  /** pdf.js ImageKind: 1 greyscale 1-bit, 2 RGB 24-bit, 3 RGBA 32-bit. */
  kind?: number;
  data?: Uint8ClampedArray | Uint8Array | null;
  /** An ImageBitmap, or a VideoFrame where the browser's own decoder did the work. */
  bitmap?: CanvasImageSource | null;
}

/** How long to wait for the worker to hand an image over before the page is drawn instead. */
const IMAGE_WAIT_MS = 8_000;

/**
 * The decoded image behind one paint operator. An inline image arrives as
 * itself; a named one is looked up on the page — or on the document, where
 * pdf.js keeps the ones several pages share (their names start `g_`) — and
 * waited for, since the operator list can finish streaming before the last
 * image has been decoded.
 */
function decodedImage(page: PDFPageProxy, ref: unknown): Promise<DecodedImage | null> {
  if (ref && typeof ref === "object") return Promise.resolve(ref as DecodedImage);
  if (typeof ref !== "string") return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), IMAGE_WAIT_MS);
    try {
      const pool = ref.startsWith("g_") ? page.commonObjs : page.objs;
      pool.get(ref, (image: DecodedImage | null) => {
        clearTimeout(timer);
        resolve(image ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function imageColour(image: DecodedImage): PageVerdict {
  try {
    if (image.kind === 1) return "mono";

    if (image.bitmap) {
      // A thumbnail-sized draw, then the same test a photo gets.
      const w = Number(image.width) || 1;
      const h = Number(image.height) || 1;
      const scale = Math.min(1, Math.sqrt(IMAGE_SAMPLE_PIXELS / (w * h)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return "unknown";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image.bitmap, 0, 0, canvas.width, canvas.height);
      return colourRatio(ctx.getImageData(0, 0, canvas.width, canvas.height).data, 1) > COLOUR_PIXEL_RATIO ? "colour" : "mono";
    }

    if (image.data && (image.kind === 2 || image.kind === 3)) {
      const stride = image.kind === 2 ? 3 : 4;
      const pixels = Math.floor(image.data.length / stride);
      const step = Math.max(1, Math.floor(pixels / IMAGE_SAMPLE_PIXELS));
      let coloured = 0;
      let sampled = 0;
      for (let p = 0; p < pixels; p += step) {
        const i = p * stride;
        if (stride === 4 && image.data[i + 3] < 8) continue;
        sampled++;
        if (spread(image.data[i], image.data[i + 1], image.data[i + 2])) coloured++;
      }
      return sampled > 0 && coloured / sampled > COLOUR_PIXEL_RATIO ? "colour" : "mono";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

async function rasterisePage(page: PDFPageProxy): Promise<PageVerdict> {
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
