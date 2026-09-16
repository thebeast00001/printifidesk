"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, CloudOff, FileUp, LayoutGrid, Loader2, Check, X } from "lucide-react";
import { useUploader } from "@/hooks/use-uploader";
import { ACCEPTED_EXTENSIONS, CONVERTS_OFFICE, formatBytes } from "@/lib/analysis";
import { selectedCount, selectedColourCount, useApp, type UploadFile } from "@/lib/store";
import { cn, easeIos, spring } from "@/lib/utils";

export function UploadStep() {
  const files = useApp((s) => s.files);
  const { accept } = useUploader();

  return (
    <div className="flex flex-col gap-3">
      <Dropzone onFiles={accept} compact={files.length > 0} />

      <AnimatePresence initial={false}>
        {files.map((file) => (
          <motion.div
            key={file.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0, marginBottom: -12 }}
            transition={spring}
          >
            <FileRow file={file} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Dropzone({ onFiles, compact }: { onFiles: (f: FileList) => void; compact: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        // dragleave fires for every child, so count entries instead of
        // clearing on the first one.
        depth.current -= 1;
        if (depth.current <= 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      }}
      className={cn(
        "relative rounded-[18px] border-2 border-dashed text-center transition-colors",
        compact ? "px-4 py-4" : "px-5 py-8",
        over ? "border-ink bg-surface-sunk" : "border-line-strong bg-surface",
      )}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS.join(",")}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
        className="sr-only"
      />

      <button onClick={() => input.current?.click()} className="w-full">
        <motion.span
          animate={{ scale: over ? 1.08 : 1 }}
          transition={spring}
          className={cn(
            "mx-auto mb-2.5 grid place-items-center rounded-2xl bg-surface-sunk text-ink-soft",
            compact ? "size-9" : "size-12",
          )}
        >
          <FileUp size={compact ? 17 : 21} strokeWidth={2} />
        </motion.span>

        <span className="block text-[14px] font-semibold tracking-[-0.01em]">
          {over ? "Drop them here" : compact ? "Add more files" : "Choose files or drop them here"}
        </span>
        {!compact && (
          <span className="mt-1 block text-[12.5px] text-muted">
            {CONVERTS_OFFICE ? "PDF, Word, PowerPoint, Excel, photos · up to 50 MB each" : "PDF or photos (JPG, PNG, HEIC) · up to 50 MB each · Word? Save it as PDF first"}
          </span>
        )}
      </button>
    </div>
  );
}

const PHASE_LABEL: Record<UploadFile["status"], string> = {
  reading: "Reading",
  scanning: "Checking pages for colour",
  uploading: "Uploading",
  ready: "Ready",
  error: "Can't use this file",
};

function FileRow({ file }: { file: UploadFile }) {
  const removeFile = useApp((s) => s.removeFile);
  const setReviewFileId = useApp((s) => s.setReviewFileId);
  const busy = file.status === "reading" || file.status === "scanning" || file.status === "uploading";
  // Counts reflect the current page selection, so the row agrees with the quote.
  const colour = selectedColourCount(file);
  const partial = file.selectedPages.length > 0;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[14px] border bg-surface px-3.5 py-3",
        file.status === "error" ? "border-clay" : "border-line",
      )}
    >
      <span
        className={cn(
          "grid size-[38px] shrink-0 place-items-center rounded-[10px] font-mono text-[9px] font-medium",
          file.status === "error"
            ? "bg-clay text-clay-ink"
            : "border border-line bg-surface-sunk text-muted",
        )}
      >
        {file.status === "error" ? <AlertCircle size={16} strokeWidth={2.2} /> : file.kind}
      </span>

      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-[13.5px] font-semibold tracking-[-0.01em]">{file.name}</p>

        <p className="m-0 mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted">
          {busy ? (
            <span className="flex items-center gap-1.5 text-ink-soft">
              <Loader2 size={11} className="animate-spin" />
              {PHASE_LABEL[file.status]}
              {file.status === "scanning" && file.progress > 0 && (
                <> {Math.round(file.progress * 100)}%</>
              )}
              {file.status === "uploading" && <> {Math.round(file.progress * 100)}%</>}
            </span>
          ) : file.status === "error" ? (
            <span className="text-clay-ink dark:text-clay">{file.error}</span>
          ) : (
            <>
              <span>
                {file.pagesExact ? "" : "≈"}
                {selectedCount(file)} {selectedCount(file) === 1 ? "page" : "pages"}
              </span>
              <span>·</span>
              <span>{formatBytes(file.sizeBytes)}</span>
              {colour > 0 && (
                <>
                  <span>·</span>
                  <span className="text-clay-ink dark:text-clay">{colour} in colour</span>
                </>
              )}
              {file.localOnly && (
                <span className="flex items-center gap-1 text-muted">
                  <CloudOff size={10} />
                  on this device
                </span>
              )}
            </>
          )}
        </p>

        {busy && (
          <span className="mt-1.5 block h-[3px] overflow-hidden rounded-sm bg-line">
            <motion.span
              animate={{ width: `${Math.round(file.progress * 100)}%` }}
              transition={{ duration: 0.25, ease: easeIos }}
              className="block h-full rounded-sm bg-ink"
            />
          </span>
        )}

        {!busy && file.note && (
          <p className="m-0 mt-1 text-[11px] leading-snug text-muted">{file.note}</p>
        )}

        {file.status === "ready" && file.pages > 0 && (
          <button
            onClick={() => setReviewFileId(file.id)}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 text-[11.5px] font-semibold text-ink-soft transition-colors hover:bg-line/50"
          >
            <LayoutGrid size={12} strokeWidth={2.2} />
            {partial ? `${selectedCount(file)} of ${file.pages} pages` : "Review pages"}
          </button>
        )}
      </div>

      {file.status === "ready" && !file.localOnly && (
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-sage text-sage-ink">
          <Check size={12} strokeWidth={3} />
        </span>
      )}

      <button
        onClick={() => removeFile(file.id)}
        aria-label={`Remove ${file.name}`}
        className="grid size-7 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-surface-sunk hover:text-ink"
      >
        <X size={15} strokeWidth={2.2} />
      </button>
    </div>
  );
}
