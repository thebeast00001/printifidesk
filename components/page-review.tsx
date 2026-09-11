"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Drawer } from "vaul";
import { motion } from "motion/react";
import { Check, FileWarning, Loader2, Palette } from "lucide-react";
import { pageThumbnail } from "@/lib/thumbnails";
import { selectedOf, useApp, type UploadFile } from "@/lib/store";
import { cn, spring } from "@/lib/utils";

/**
 * Page-by-page review. Every thumbnail is the real rendered page, and the
 * colour badge is the same per-page verdict the quote is priced from — so what
 * you deselect is exactly what stops being charged.
 */
export function PageReview() {
  const reviewFileId = useApp((s) => s.reviewFileId);
  const setReviewFileId = useApp((s) => s.setReviewFileId);
  const file = useApp((s) => s.files.find((f) => f.id === s.reviewFileId));

  return (
    <Drawer.Root open={Boolean(reviewFileId)} onOpenChange={(v) => !v && setReviewFileId(null)}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.5)] backdrop-blur-[3px]" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-80 mx-auto flex max-h-[92dvh] w-full max-w-[720px] flex-col
                     rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]"
        >
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />
          {file ? <ReviewBody file={file} /> : <Drawer.Title className="sr-only">Pages</Drawer.Title>}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function ReviewBody({ file }: { file: UploadFile }) {
  const updateFile = useApp((s) => s.updateFile);
  const setReviewFileId = useApp((s) => s.setReviewFileId);

  const chosen = useMemo(() => new Set(selectedOf(file)), [file]);
  const colour = useMemo(() => new Set(file.colourIndex), [file.colourIndex]);
  const pages = useMemo(
    () => Array.from({ length: file.pages }, (_, i) => i + 1),
    [file.pages],
  );

  function setSelection(next: number[]) {
    // Sorted, and "everything" is stored as [] so the meaning stays "all pages"
    // even if the page count is re-measured after conversion.
    const sorted = [...new Set(next)].sort((a, b) => a - b);
    updateFile(file.id, { selectedPages: sorted.length === file.pages ? [] : sorted });
  }

  const toggle = (n: number) =>
    setSelection(chosen.has(n) ? [...chosen].filter((p) => p !== n) : [...chosen, n]);

  const canRender = Boolean(file.file) && file.kind === "PDF";

  return (
    <>
      <div className="shrink-0 px-[18px] pt-3.5">
        <Drawer.Title className="font-figure m-0 mb-1 text-[23px] font-extrabold">
          Review pages
        </Drawer.Title>
        <Drawer.Description className="m-0 mb-3.5 truncate text-[13px] text-muted">
          {file.name}
        </Drawer.Description>

        <div className="flex flex-wrap gap-2 pb-3.5">
          <Quick label="All" onClick={() => setSelection(pages)} />
          <Quick label="None" onClick={() => setSelection([])} disabled />
          <Quick label="Odd" onClick={() => setSelection(pages.filter((n) => n % 2 === 1))} />
          <Quick label="Even" onClick={() => setSelection(pages.filter((n) => n % 2 === 0))} />
          {file.colourIndex.length > 0 && (
            <Quick
              label="Colour only"
              onClick={() => setSelection(file.colourIndex)}
            />
          )}
          <Quick
            label="Skip colour"
            onClick={() => setSelection(pages.filter((n) => !colour.has(n)))}
          />
        </div>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px]">
        {!canRender && (
          <p className="mb-3 flex items-start gap-2.5 rounded-[14px] border border-line bg-surface px-3.5 py-3 text-[12.5px] leading-relaxed text-muted">
            <FileWarning size={15} strokeWidth={2.2} className="mt-px shrink-0" />
            {file.kind === "PDF"
              ? "This file was restored from a previous session, so previews aren't available. You can still choose pages."
              : "Previews are only available for PDFs. This file is converted before printing, so pages are chosen by number."}
          </p>
        )}

        <div className="grid grid-cols-3 gap-2.5 pb-4 sm:grid-cols-4 lg:grid-cols-5">
          {pages.map((n) => (
            <PageTile
              key={n}
              file={file}
              pageNumber={n}
              selected={chosen.has(n)}
              hasColour={colour.has(n)}
              canRender={canRender}
              onToggle={() => toggle(n)}
            />
          ))}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-paper/[0.92] px-[18px] pt-3.5 pb-[max(18px,env(safe-area-inset-bottom))] backdrop-blur-xl">
        <div className="mb-3 flex items-center justify-between gap-4">
          <p className="m-0 font-mono text-[12px] text-muted">
            {chosen.size} of {file.pages} pages
            {file.colourIndex.length > 0 && (
              <>
                {" · "}
                {file.colourIndex.filter((p) => chosen.has(p)).length} in colour
              </>
            )}
          </p>
          {chosen.size === 0 && (
            <p className="m-0 text-[11.5px] font-semibold text-clay-ink dark:text-clay">
              Pick at least one page
            </p>
          )}
        </div>
        <motion.button
          whileTap={{ scale: 0.98 }}
          transition={spring}
          disabled={chosen.size === 0}
          onClick={() => setReviewFileId(null)}
          className="h-[52px] w-full rounded-2xl bg-ink text-[15px] font-semibold text-paper disabled:opacity-50"
        >
          Done
        </motion.button>
      </div>
    </>
  );
}

function Quick({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink-soft transition-colors hover:bg-surface-sunk disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function PageTile({
  file,
  pageNumber,
  selected,
  hasColour,
  canRender,
  onToggle,
}: {
  file: UploadFile;
  pageNumber: number;
  selected: boolean;
  hasColour: boolean;
  canRender: boolean;
  onToggle: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  /* Render only what scrolls into view — a 200-page PDF must not rasterise
     everything the moment the sheet opens. */
  const load = useCallback(async () => {
    if (!canRender || !file.file || src) return;
    const url = await pageThumbnail(file.id, file.file, pageNumber);
    if (url) setSrc(url);
    else setFailed(true);
  }, [canRender, file.file, file.id, pageNumber, src]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canRender) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void load();
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [load, canRender]);

  return (
    <button
      ref={ref}
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        "group relative overflow-hidden rounded-xl border-2 bg-surface transition-colors",
        selected ? "border-ink" : "border-line hover:border-line-strong",
      )}
    >
      <span
        className={cn(
          "flex aspect-[1/1.414] items-center justify-center overflow-hidden bg-surface-sunk transition-opacity",
          !selected && "opacity-45",
        )}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={`Page ${pageNumber}`} className="size-full object-contain" />
        ) : failed || !canRender ? (
          <span className="font-figure text-[22px] font-extrabold text-faint">{pageNumber}</span>
        ) : (
          <Loader2 size={15} className="animate-spin text-faint" />
        )}
      </span>

      <span className="absolute top-1.5 left-1.5 rounded-md bg-paper/85 px-1.5 py-0.5 font-mono text-[10px] font-medium backdrop-blur">
        {pageNumber}
      </span>

      {hasColour && (
        <span
          title="This page needs colour ink"
          className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-md bg-clay text-clay-ink"
        >
          <Palette size={11} strokeWidth={2.4} />
        </span>
      )}

      <span
        className={cn(
          "absolute right-1.5 bottom-1.5 grid size-5 place-items-center rounded-full transition-colors",
          selected ? "bg-ink text-paper" : "border border-line-strong bg-paper/85 backdrop-blur",
        )}
      >
        {selected && <Check size={12} strokeWidth={3} />}
      </span>
    </button>
  );
}
