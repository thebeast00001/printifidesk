"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { CornerDownLeft, FileText, Loader2, Receipt, Search, X } from "lucide-react";
import { useAuthKey } from "@/hooks/use-auth-key";
import { ensureSession } from "@/lib/supabase/client";
import { listDocuments, type DocumentRow } from "@/lib/upload";
import { listOrders, STATUS_LABEL, type OrderRow } from "@/lib/orders";
import { useApp } from "@/lib/store";
import { cn, spring } from "@/lib/utils";

type Group = "Your files" | "Orders";

interface Hit {
  id: string;
  group: Group;
  title: string;
  meta: string;
  run: () => void;
}

/** Searches the two things that actually exist: your documents and your orders. */
export function SearchDialog() {
  const authKey = useAuthKey();
  const open = useApp((s) => s.searchOpen);
  const setOpen = useApp((s) => s.setSearchOpen);
  const openSheet = useApp((s) => s.openSheet);
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const load = useCallback(async () => {
    const session = await ensureSession();
    if (session.status !== "ready") {
      setDocs([]);
      setOrders([]);
      return;
    }
    const [d, o] = await Promise.all([listDocuments(), listOrders()]);
    setDocs(d);
    setOrders(o);
  }, [authKey]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setDocs(null);
    void load();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, load]);

  const hits = useMemo<Hit[]>(() => {
    const all: Hit[] = [
      ...(docs ?? []).map((d) => ({
        id: `d-${d.id}`,
        group: "Your files" as const,
        title: d.name,
        meta: `${d.pages} pages${d.colour_pages ? ` · ${d.colour_pages} colour` : ""}`,
        run: () => openSheet("upload"),
      })),
      ...orders.map((o) => ({
        id: `o-${o.id}`,
        group: "Orders" as const,
        title: `${o.token ?? "—"} · ${o.order_items?.[0]?.name ?? `${o.pages} pages`}`,
        meta: `${STATUS_LABEL[o.status]} · ${new Date(o.created_at).toLocaleDateString([], {
          day: "numeric",
          month: "short",
        })}`,
        run: () => router.push("/orders"),
      })),
    ];

    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 8);

    return all
      .map((hit) => ({ hit, score: score(hit, q) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((r) => r.hit);
  }, [query, docs, orders, openSheet, router]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function commit(hit: Hit | undefined) {
    if (!hit) return;
    setOpen(false);
    hit.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(hits[cursor]);
    }
  }

  let lastGroup: Group | null = null;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-70 bg-[rgb(12_12_14/0.42)] backdrop-blur-[3px]"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={spring}
            className="fixed inset-x-4 top-[12vh] z-80 mx-auto flex max-h-[70dvh] w-auto max-w-[560px] flex-col
                       overflow-hidden rounded-[22px] border border-line bg-paper shadow-lift"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search size={17} strokeWidth={2.2} className="shrink-0 text-faint" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search your files and orders"
                className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
              />
              <button
                onClick={() => setOpen(false)}
                aria-label="Close search"
                className="grid size-7 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-surface-sunk hover:text-ink"
              >
                <X size={15} strokeWidth={2.2} />
              </button>
            </div>

            <div ref={listRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
              {docs === null ? (
                <p className="flex items-center justify-center gap-2.5 px-3 py-8 text-[13px] text-muted">
                  <Loader2 size={14} className="animate-spin" />
                  Loading…
                </p>
              ) : hits.length === 0 ? (
                <p className="px-3 py-8 text-center text-[13px] text-muted">
                  {query
                    ? `Nothing matches “${query}”.`
                    : "Nothing to search yet — upload a file to get started."}
                </p>
              ) : (
                hits.map((hit, i) => {
                  const showGroup = hit.group !== lastGroup;
                  lastGroup = hit.group;
                  return (
                    <div key={hit.id}>
                      {showGroup && <p className="label-caps px-3 pt-3 pb-1.5">{hit.group}</p>}
                      <button
                        data-index={i}
                        onMouseMove={() => setCursor(i)}
                        onClick={() => commit(hit)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors",
                          i === cursor ? "bg-surface" : "bg-transparent",
                        )}
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-line bg-surface-sunk text-muted">
                          {hit.group === "Orders" ? (
                            <Receipt size={15} strokeWidth={2} />
                          ) : (
                            <FileText size={15} strokeWidth={2} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em]">
                            <Highlight text={hit.title} query={query} />
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">
                            {hit.meta}
                          </span>
                        </span>
                        {i === cursor && (
                          <CornerDownLeft size={14} strokeWidth={2} className="shrink-0 text-faint" />
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 font-mono text-[10.5px] text-muted">
              <span>↑↓ move</span>
              <span>↵ open</span>
              <span>esc close</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/** Every query word must appear; earlier matches and title hits rank higher. */
function score(hit: Hit, query: string): number {
  const haystack = `${hit.title} ${hit.meta}`.toLowerCase();
  const title = hit.title.toLowerCase();
  let total = 0;

  for (const word of query.split(/\s+/).filter(Boolean)) {
    const inTitle = title.indexOf(word);
    const inAny = haystack.indexOf(word);
    if (inAny === -1) return 0;
    total += inTitle === 0 ? 100 : inTitle > 0 ? 50 : 10;
    total += Math.max(0, 20 - inAny);
  }
  return total;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;

  const words = q.split(/\s+/).filter(Boolean).map(escapeRegex);
  const parts = text.split(new RegExp(`(${words.join("|")})`, "ig"));

  return (
    <>
      {parts.map((part, i) =>
        words.some((w) => new RegExp(`^${w}$`, "i").test(part)) ? (
          <mark key={i} className="rounded-[3px] bg-sage px-0.5 text-sage-ink">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
