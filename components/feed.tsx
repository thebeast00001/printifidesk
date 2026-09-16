"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";
import { useAuthKey } from "@/hooks/use-auth-key";
import { ensureSession } from "@/lib/supabase/client";
import { SignedOutNotice } from "./signed-out-notice";
import { OperatorRates } from "./operator-rates";
import { deleteDocument, listDocuments, type DocumentRow } from "@/lib/upload";
import { formatBytes } from "@/lib/analysis";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

type State =
  | { kind: "loading" }
  | { kind: "ready"; docs: DocumentRow[] }
  | { kind: "signed-out" }
  | { kind: "offline"; message: string };

/**
 * Your stored documents, straight from the `documents` table. There is no
 * seeded content here — an empty account shows an empty shelf.
 */
export function Feed() {
  const authKey = useAuthKey();
  const [state, setState] = useState<State>({ kind: "loading" });
  const openSheet = useApp((s) => s.openSheet);

  const load = useCallback(async () => {
    const session = await ensureSession();
    if (session.status === "signed-out") return setState({ kind: "signed-out" });
    if (session.status !== "ready") {
      return setState({
        kind: "offline",
        message: "message" in session ? session.message : "Starting up…",
      });
    }
    setState({ kind: "ready", docs: await listDocuments() });
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(doc: DocumentRow) {
    await deleteDocument(doc.id, doc.storage_path);
    await load();
  }

  return (
    <section id="feed" data-anim="feed" className="scroll-mt-6">
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2 className="font-heading m-0 text-[19px] font-bold lg:text-[22px]">Your files</h2>
        {state.kind === "ready" && state.docs.length > 0 && (
          <span className="font-mono text-[11.5px] text-muted">
            {state.docs.length} stored
          </span>
        )}
      </div>

      {state.kind === "loading" && (
        <Panel>
          <Loader2 size={15} className="animate-spin" />
          Loading your files…
        </Panel>
      )}

      {state.kind === "signed-out" && (
        <>
          <SignedOutNotice
            title="Sign in to keep your files"
            body="Uploads are kept in your account — private to you — until you delete them, or six hours after the order they're on is collected."
          />
          <OperatorRates />
        </>
      )}

      {state.kind === "offline" && (
        <Panel tone="clay">
          <AlertCircle size={15} strokeWidth={2.2} />
          Can&apos;t load your files right now. Try again in a moment.
        </Panel>
      )}

      {state.kind === "ready" && state.docs.length === 0 && (
        <div className="rounded-[20px] border border-line bg-surface p-8 text-center shadow-card">
          <p className="m-0 text-[14px] font-semibold tracking-[-0.01em]">Nothing stored yet</p>
          <p className="m-0 mt-1.5 text-[12.5px] text-muted">
            Files you upload are kept here so you can reprint them in one tap.
          </p>
          <button
            onClick={() => openSheet("upload")}
            className="mt-4 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-semibold text-paper"
          >
            Upload files
          </button>
        </div>
      )}

      {/* An empty shelf is honest but answers nothing. The rates are real data
          from the operator's own row, so this is the one thing worth showing
          before there is anything to show. */}
      {state.kind === "ready" && state.docs.length === 0 && <OperatorRates />}

      {state.kind === "ready" && state.docs.length > 0 && (
        <div
          className={cn(
            /* A rail you thumb through on a phone; a grid that fills the
               column on a laptop, where horizontal scrolling is a nuisance. */
            "no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pt-0.5 pb-1 sm:-mx-6 sm:px-6",
            "lg:mx-0 lg:grid lg:grid-cols-3 lg:gap-4 lg:overflow-visible lg:px-0",
          )}
        >
          {state.docs.map((doc) => (
            <DocCard key={doc.id} doc={doc} onDelete={() => remove(doc)} />
          ))}
        </div>
      )}
    </section>
  );
}

function DocCard({ doc, onDelete }: { doc: DocumentRow; onDelete: () => void }) {
  const openSheet = useApp((s) => s.openSheet);
  const colour = doc.colour_pages ?? 0;
  // Preview bars stand in for the page image — pdf.js thumbnails would mean
  // re-downloading the file, so the count drives the shape instead.
  const lines = Math.min(7, Math.max(3, Math.round((doc.pages ?? 1) / 8)));

  return (
    <div className="group relative w-[144px] shrink-0 rounded-[18px] border border-line bg-surface p-3 text-left shadow-card transition-shadow hover:shadow-lift lg:w-auto lg:p-4">
      <motion.button
        whileTap={{ scale: 0.97 }}
        onClick={() => openSheet("upload")}
        className="block w-full text-left"
      >
        <span
          className={cn(
            "mb-2.5 flex h-[74px] flex-col gap-[3.5px] overflow-hidden rounded-[9px] p-[9px] lg:h-[110px] lg:gap-1.5 lg:p-3",
            colour > 0 ? "bg-bone" : "border border-line bg-surface-sunk",
          )}
        >
          {Array.from({ length: lines }).map((_, i) => (
            <b
              key={i}
              style={{ width: `${[100, 84, 62, 92, 74, 100, 56][i % 7]}%` }}
              className={cn("block h-0.5 rounded-sm", colour > 0 ? "bg-ink/20" : "bg-line-strong")}
            />
          ))}
        </span>

        <p className="m-0 mb-1 line-clamp-2 text-[13px] leading-snug font-semibold tracking-[-0.01em] lg:text-sm">
          {doc.name}
        </p>
        <span className="font-mono text-[10.5px] tracking-[-0.01em] text-muted lg:text-[11.5px]">
          {doc.pages_exact ? "" : "≈"}
          {doc.pages} p
          {colour > 0 && ` · ${colour} colour`}
          {" · "}
          {formatBytes(doc.size_bytes ?? 0)}
        </span>
      </motion.button>

      <button
        onClick={onDelete}
        aria-label={`Delete ${doc.name}`}
        className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-surface/80 text-faint opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink"
      >
        <Trash2 size={13} strokeWidth={2.2} />
      </button>
    </div>
  );
}

function Panel({ children, tone }: { children: React.ReactNode; tone?: "clay" }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-[20px] border p-4 text-[13px]",
        tone === "clay" ? "border-clay bg-clay/25 text-ink" : "border-line bg-surface text-muted",
      )}
    >
      {children}
    </div>
  );
}
