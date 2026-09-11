"use client";

import { create } from "zustand";
import { DEFAULT_CONFIG, type PrintConfig, type QuoteLine } from "./pricing";
import type { FileKind } from "./analysis";
import { releaseThumbnails } from "./thumbnails";

export type SheetStep = "upload" | "options";

export type UploadStatus = "reading" | "scanning" | "uploading" | "ready" | "error";

export interface UploadFile {
  id: string;
  name: string;
  kind: FileKind;
  sizeBytes: number;
  /** Kept so the review sheet can render page thumbnails without a re-download. */
  file?: File;
  /** 1-based page numbers that will actually print. Empty until analysed. */
  selectedPages: number[];
  status: UploadStatus;
  /** 0–1, whatever the current phase is doing. */
  progress: number;
  pages: number;
  colourIndex: number[];
  pagesExact: boolean;
  note?: string;
  error?: string;
  storagePath?: string;
  /** True when it exists only in this browser — Supabase wasn't reachable. */
  localOnly?: boolean;
  /**
   * Print settings for this file alone.
   *
   * A colour cover with a black-and-white body is one order with two answers,
   * so the settings belong to the file rather than the job. New files start
   * from whatever the sheet is currently set to.
   */
  config: PrintConfig;
}

/**
 * Client state only: what's in the sheet right now, and which overlay is open.
 * Orders, documents, wallet and totals all live in Postgres and are read
 * through `hooks/use-tracking.ts` — nothing about a real order is mirrored here.
 */
interface AppState {
  sheetOpen: boolean;
  sheetStep: SheetStep;
  openSheet: (step?: SheetStep) => void;
  closeSheet: () => void;
  setStep: (step: SheetStep) => void;

  files: UploadFile[];
  addFile: (file: UploadFile) => void;
  updateFile: (id: string, patch: Partial<UploadFile>) => void;
  removeFile: (id: string) => void;
  clearFiles: () => void;

  /**
   * The sheet-wide setting: what a newly added file starts from, and what the
   * top chips write to every file at once.
   */
  config: PrintConfig;
  setConfig: <K extends keyof PrintConfig>(key: K, value: PrintConfig[K]) => void;
  /** Overrides one file without touching the others. */
  setFileConfig: <K extends keyof PrintConfig>(id: string, key: K, value: PrintConfig[K]) => void;
  /** Puts one file back in step with the rest. */
  resetFileConfig: (id: string) => void;

  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  breakdownOpen: boolean;
  setBreakdownOpen: (open: boolean) => void;
  /** Which file's pages are being reviewed, if any. */
  reviewFileId: string | null;
  setReviewFileId: (id: string | null) => void;

  /**
   * The operator page has two faces — the queue and the settings — and the
   * floating dock switches between them, so the choice lives here rather than
   * inside the page. Nothing about a real operator is mirrored; this is which
   * panel is open.
   */
  operatorView: "queue" | "settings";
  setOperatorView: (view: "queue" | "settings") => void;
  /** Orders waiting to be accepted, for the dock's badge. Null until known. */
  operatorPending: number | null;
  setOperatorPending: (n: number | null) => void;
}

export const useApp = create<AppState>((set) => ({
  sheetOpen: false,
  sheetStep: "upload",
  openSheet: (step = "upload") => set({ sheetOpen: true, sheetStep: step }),
  closeSheet: () => set({ sheetOpen: false }),
  setStep: (sheetStep) => set({ sheetStep }),

  files: [],
  addFile: (file) => set((s) => ({ files: [...s.files, file] })),
  updateFile: (id, patch) =>
    set((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, ...patch } : f)) })),
  removeFile: (id) =>
    set((s) => {
      releaseThumbnails(id);
      return { files: s.files.filter((f) => f.id !== id) };
    }),
  clearFiles: () =>
    set((s) => {
      s.files.forEach((f) => releaseThumbnails(f.id));
      return { files: [] };
    }),

  config: DEFAULT_CONFIG,
  // A top-level chip writes through to every file. Anything else — leaving
  // customised files behind, or silently resetting them — makes the chips mean
  // two different things depending on state, which is worse than either.
  setConfig: (key, value) =>
    set((s) => ({
      config: { ...s.config, [key]: value },
      files: s.files.map((f) => ({ ...f, config: { ...f.config, [key]: value } })),
    })),
  setFileConfig: (id, key, value) =>
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, config: { ...f.config, [key]: value } } : f)),
    })),
  resetFileConfig: (id) =>
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, config: { ...s.config } } : f)),
    })),

  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  breakdownOpen: false,
  setBreakdownOpen: (breakdownOpen) => set({ breakdownOpen }),
  reviewFileId: null,
  setReviewFileId: (reviewFileId) => set({ reviewFileId }),

  operatorView: "queue",
  setOperatorView: (operatorView) => set({ operatorView }),
  operatorPending: null,
  setOperatorPending: (operatorPending) => set({ operatorPending }),
}));

/* ---------- selectors ---------- */

/** Pages a file will actually print — its selection, or all of them. */
export const selectedOf = (f: UploadFile): number[] =>
  f.selectedPages.length ? f.selectedPages : Array.from({ length: f.pages }, (_, i) => i + 1);

export const selectedCount = (f: UploadFile) =>
  f.selectedPages.length ? f.selectedPages.length : f.pages;

export const selectedColourCount = (f: UploadFile) => {
  if (!f.selectedPages.length) return f.colourIndex.length;
  const chosen = new Set(f.selectedPages);
  return f.colourIndex.filter((p) => chosen.has(p)).length;
};

export const totalPages = (files: UploadFile[]) =>
  files.filter((f) => f.status === "ready").reduce((n, f) => n + selectedCount(f), 0);

export const totalColourPages = (files: UploadFile[]) =>
  files.filter((f) => f.status === "ready").reduce((n, f) => n + selectedColourCount(f), 0);

export const allExact = (files: UploadFile[]) =>
  files.filter((f) => f.status === "ready").every((f) => f.pagesExact);

/** Files that will actually be sent. */
export const readyFiles = (files: UploadFile[]) => files.filter((f) => f.status === "ready");

/** One priced line per file, which is what `quoteOrder` takes. */
export const linesOf = (files: UploadFile[]): QuoteLine[] =>
  readyFiles(files).map((f) => ({
    pages: selectedCount(f),
    colourPages: selectedColourCount(f),
    config: f.config,
  }));

/**
 * Which settings every file agrees on.
 *
 * A key is in `varies` when the files disagree, so the chip row can show that
 * honestly instead of picking one file's answer and looking wrong.
 */
export function sharedConfig(
  files: UploadFile[],
  fallback: PrintConfig,
): { config: PrintConfig; varies: Set<keyof PrintConfig> } {
  const ready = readyFiles(files);
  if (ready.length === 0) return { config: fallback, varies: new Set() };

  const first = ready[0].config;
  const varies = new Set<keyof PrintConfig>();
  for (const key of ["colour", "sides", "binding", "copies"] as const) {
    if (ready.some((f) => f.config[key] !== first[key])) varies.add(key);
  }
  return { config: first, varies };
}

/** True when this file has drifted from the sheet-wide setting. */
export const isCustomised = (file: UploadFile, sheet: PrintConfig) =>
  (["colour", "sides", "binding", "copies"] as const).some((k) => file.config[k] !== sheet[k]);
