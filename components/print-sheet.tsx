"use client";

import { useMemo, useState } from "react";
import { Drawer } from "vaul";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Loader2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { Figure } from "./figure";
import { Bill } from "./bill";
import { UploadStep } from "./upload-step";
import { createOrder, defaultOperatorId } from "@/lib/orders";
import { PickupPicker } from "./pickup-picker";
import { useOperatorWait } from "@/hooks/use-tracking";
import {
  allExact,
  isCustomised,
  linesOf,
  selectedColourCount,
  selectedCount,
  sharedConfig,
  totalColourPages,
  totalPages,
  useApp,
  type UploadFile,
} from "@/lib/store";
import {
  describeOrder,
  linePrice,
  money,
  perPage,
  quoteOrder,
  rateCardOf,
  type PrintConfig,
  type RateCard,
} from "@/lib/pricing";
import { cn, easeIos, spring } from "@/lib/utils";

type Group = keyof PrintConfig;

interface Option {
  value: string | number;
  label: string;
  sub?: string;
}

/** Every rate shown here is the operator's own, read from their row. */
function optionsFor(
  colourPages: number,
  card: RateCard,
): { group: Group; title: string; options: Option[] }[] {
  return [
    {
      group: "colour",
      title: "Colour",
      options: [
        {
          value: "smart",
          label: "Smart",
          sub: colourPages === 0 ? "no colour found" : `${colourPages} in colour`,
        },
        { value: "bw", label: "Black & white", sub: perPage(card.bwPerPage, card.currency) },
        { value: "full", label: "Full colour", sub: perPage(card.colourPerPage, card.currency) },
      ],
    },
    {
      group: "sides",
      title: "Sides",
      options: [
        {
          value: "double",
          label: "Both sides",
          sub: card.duplexDiscount > 0 ? `−${Math.round(card.duplexDiscount * 100)}%` : undefined,
        },
        { value: "single", label: "One side" },
      ],
    },
    {
      group: "binding",
      title: "Finish",
      options: [
        { value: "none", label: "Loose" },
        {
          value: "staple",
          label: "Staple",
          sub: card.staplePrice > 0 ? `+${money(card.staplePrice, card.currency)}` : undefined,
        },
      ],
    },
  ];
}

const COPY_PRESETS = [1, 2, 3, 5, 10];
const MAX_COPIES = 200;

/** Presets for the common cases, a free field for everything else. */
function CopiesPicker({
  copies,
  varies,
  idPrefix,
  onChange,
}: {
  copies: number;
  varies: boolean;
  idPrefix: string;
  onChange: (n: number) => void;
}) {
  const [custom, setCustom] = useState("");
  const isPreset = !varies && COPY_PRESETS.includes(copies);

  function commit(raw: string) {
    setCustom(raw);
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) onChange(Math.min(n, MAX_COPIES));
  }

  return (
    <div className="mt-[18px]">
      <p className="label-caps m-0 mb-2.5">
        Copies
        {varies && <VariesTag />}
      </p>
      <div className="flex flex-wrap items-center gap-[7px]">
        {COPY_PRESETS.map((n) => {
          const active = !varies && copies === n;
          return (
            <motion.button
              key={n}
              whileTap={{ scale: 0.95 }}
              transition={spring}
              aria-pressed={active}
              onClick={() => {
                onChange(n);
                setCustom("");
              }}
              className={cn(
                "relative min-w-[46px] rounded-xl border px-3.5 py-2.5 text-[13px] font-semibold",
                active ? "border-ink text-paper" : "border-line bg-surface text-ink-soft",
              )}
            >
              {active && (
                <motion.span
                  layoutId={`seg-${idPrefix}-copies`}
                  transition={spring}
                  className="absolute inset-0 rounded-xl bg-ink"
                />
              )}
              <span className="relative">{n}</span>
            </motion.button>
          );
        })}

        <div
          className={cn(
            "flex items-center gap-1.5 rounded-xl border px-3 py-1.5 transition-colors",
            !isPreset && !varies ? "border-ink bg-ink text-paper" : "border-line bg-surface",
          )}
        >
          <input
            type="number"
            min={1}
            max={MAX_COPIES}
            inputMode="numeric"
            value={varies ? "" : !isPreset && !custom ? String(copies) : custom}
            onChange={(e) => commit(e.target.value)}
            placeholder={varies ? "Set all" : "Other"}
            aria-label="Custom number of copies"
            className={cn(
              "w-[62px] bg-transparent text-[13px] font-semibold outline-none",
              !isPreset && !varies
                ? "text-paper placeholder:text-paper/60"
                : "text-ink placeholder:text-faint",
            )}
          />
        </div>
      </div>

      {copies >= MAX_COPIES && (
        <p className="m-0 mt-2 text-[11.5px] text-muted">
          {MAX_COPIES} is the most a single job can take — split it into two orders.
        </p>
      )}
    </div>
  );
}

/** Says "these files disagree" rather than showing one file's answer as if it were everyone's. */
function VariesTag() {
  return (
    <span className="ml-1.5 rounded-full bg-surface-sunk px-2 py-0.5 text-[9.5px] font-semibold tracking-normal text-muted">
      varies by file
    </span>
  );
}

/**
 * A price difference, or nothing at all when there isn't one.
 *
 * The real figure, not a hint: `quoteOrder` is pure, so re-running it with one
 * option swapped is exact. A chip that says −₹24 means the total at the bottom
 * of the sheet will drop by exactly that.
 */
function deltaLabel(delta: number, currency: string): string | null {
  if (delta === 0) return null;
  return `${delta > 0 ? "+" : "−"}${money(Math.abs(delta), currency)}`;
}

/**
 * The chip rows, used both for the whole job and for a single file.
 *
 * `delta` is supplied by the caller because what a chip costs depends on what
 * it applies to — switching every file to one-sided is a different number from
 * switching one.
 */
/**
 * The desk's extras (0039): its own names and prices, as many as apply.
 * Each chip shows what adding it would do to this total, the way the
 * other rows do; a chip that's already on shows the desk's price.
 */
function ExtrasRow({
  card,
  chosen,
  varies,
  copies,
  delta,
  onChange,
}: {
  card: RateCard;
  chosen: string[];
  varies: boolean;
  copies: number;
  delta: (next: string[]) => number;
  onChange: (next: string[]) => void;
}) {
  if (card.extras.length === 0) return null;
  return (
    <div className="mt-[18px]">
      <p className="label-caps m-0 mb-2.5">
        Extras
        {varies && <VariesTag />}
      </p>
      <div className="flex flex-wrap gap-[7px]">
        {card.extras.map((e) => {
          const active = !varies && chosen.includes(e.id);
          const next = active ? chosen.filter((id) => id !== e.id) : [...chosen.filter((id) => id !== e.id), e.id];
          const label = deltaLabel(delta(next), card.currency);
          const own = `+${money(e.price, card.currency)}${e.per === "copy" && copies > 1 ? ` × ${copies}` : e.per === "copy" ? "/copy" : ""}`;
          return (
            <motion.button
              key={e.id}
              whileTap={{ scale: 0.95 }}
              transition={spring}
              aria-pressed={active}
              onClick={() => onChange(next)}
              className={cn(
                "rounded-xl border px-3.5 py-2.5 text-[13px] font-semibold tracking-[-0.01em]",
                active ? "border-ink bg-ink text-paper" : "border-line bg-surface text-ink-soft",
              )}
            >
              <span className="block">
                {e.name}
                <span className={cn("mt-px block font-mono text-[10px] font-normal", active ? "opacity-60" : "opacity-80")}>
                  {active ? own : label ?? own}
                </span>
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

function ChipGroups({
  colourPages,
  card,
  config,
  varies,
  idPrefix,
  delta,
  onChange,
  smartNote,
}: {
  colourPages: number;
  card: RateCard;
  config: PrintConfig;
  varies: Set<Group>;
  idPrefix: string;
  delta: (group: Group, value: string | number | string[]) => number;
  onChange: <K extends Group>(key: K, value: PrintConfig[K]) => void;
  smartNote?: React.ReactNode;
}) {
  return (
    <>
      {optionsFor(colourPages, card).map(({ group, title, options }) => (
        <div key={group} className="mt-[18px]">
          <p className="label-caps m-0 mb-2.5">
            {title}
            {varies.has(group) && <VariesTag />}
          </p>
          <div className="flex flex-wrap gap-[7px]">
            {options.map((opt) => {
              const active = !varies.has(group) && config[group] === opt.value;
              // What switching would cost, shown in place of the rate. The rate
              // stays on the option you're already on, where it explains the
              // price rather than a change to it.
              const label = deltaLabel(delta(group, opt.value), card.currency);
              const sub = label ?? opt.sub;

              return (
                <motion.button
                  key={String(opt.value)}
                  whileTap={{ scale: 0.95 }}
                  transition={spring}
                  aria-pressed={active}
                  onClick={() => onChange(group, opt.value as PrintConfig[typeof group] & never)}
                  className={cn(
                    "relative rounded-xl border px-3.5 py-2.5 text-[13px] font-semibold tracking-[-0.01em]",
                    active ? "border-ink text-paper" : "border-line bg-surface text-ink-soft",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId={`seg-${idPrefix}-${group}`}
                      transition={spring}
                      className="absolute inset-0 rounded-xl bg-ink"
                    />
                  )}
                  <span className="relative block">
                    {opt.label}
                    {sub && (
                      <span
                        className={cn(
                          "mt-px block font-mono text-[10px] font-normal",
                          label && !active ? "opacity-80" : "opacity-60",
                        )}
                      >
                        {sub}
                      </span>
                    )}
                  </span>
                </motion.button>
              );
            })}
          </div>

          {group === "colour" && smartNote}
        </div>
      ))}
    </>
  );
}

export function PrintSheet() {
  const open = useApp((s) => s.sheetOpen);
  const step = useApp((s) => s.sheetStep);
  const setStep = useApp((s) => s.setStep);
  const closeSheet = useApp((s) => s.closeSheet);
  const openSheet = useApp((s) => s.openSheet);
  const files = useApp((s) => s.files);

  const ready = files.filter((f) => f.status === "ready");
  const busy = files.some((f) => ["reading", "scanning", "uploading"].includes(f.status));

  return (
    <Drawer.Root open={open} onOpenChange={(v) => (v ? openSheet(step) : closeSheet())}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-[rgb(12_12_14/0.42)] backdrop-blur-[3px]" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-60 mx-auto flex max-h-[90dvh] w-full max-w-[560px] flex-col
                     rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]"
        >
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />

          {step === "upload" ? (
            <UploadPane ready={ready.length} busy={busy} onNext={() => setStep("options")} />
          ) : (
            <OptionsPane files={ready} onBack={() => setStep("upload")} />
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function UploadPane({
  ready,
  busy,
  onNext,
}: {
  ready: number;
  busy: boolean;
  onNext: () => void;
}) {
  return (
    <>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5">
        <Drawer.Title className="font-figure m-0 mb-1 text-[23px] font-extrabold">
          Add your files
        </Drawer.Title>
        <Drawer.Description className="m-0 mb-4 text-[13px] text-muted">
          We count the pages and check which ones actually need colour, before you pay.
        </Drawer.Description>

        <UploadStep />
        <div className="h-3" />
      </div>

      <div className="shrink-0 border-t border-line bg-paper/[0.92] px-[18px] pt-3.5 pb-[max(18px,env(safe-area-inset-bottom))] backdrop-blur-xl">
        <motion.button
          whileTap={{ scale: ready ? 0.98 : 1 }}
          transition={spring}
          onClick={onNext}
          disabled={ready === 0}
          className={cn(
            "flex h-[54px] w-full items-center justify-center gap-2.5 rounded-2xl text-[15px] font-semibold tracking-[-0.01em] transition-colors",
            ready
              ? "bg-ink text-paper"
              : "cursor-not-allowed border border-line bg-surface text-faint",
          )}
        >
          {ready === 0
            ? busy
              ? "Reading your files…"
              : "Add a file to continue"
            : `Choose print options · ${ready} ${ready === 1 ? "file" : "files"}`}
          {ready > 0 && <ArrowRight size={17} strokeWidth={2.2} />}
        </motion.button>
      </div>
    </>
  );
}

function OptionsPane({ files, onBack }: { files: UploadFile[]; onBack: () => void }) {
  const sheetConfig = useApp((s) => s.config);
  const setConfig = useApp((s) => s.setConfig);
  const setFileConfig = useApp((s) => s.setFileConfig);
  const resetFileConfig = useApp((s) => s.resetFileConfig);
  const closeSheet = useApp((s) => s.closeSheet);
  const clearFiles = useApp((s) => s.clearFiles);
  const setStep = useApp((s) => s.setStep);

  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [showBill, setShowBill] = useState(false);
  // null means "as soon as possible"; an ISO string means a booked slot.
  const [pickupAt, setPickupAt] = useState<string | null>(null);
  const { operator, wait, ready: waitReady } = useOperatorWait();
  // Preparing a job while closed is fine; sending one that nobody will pick up
  // is not, so the button is what's gated.
  const closed = waitReady && !wait?.open;

  const pages = totalPages(files);
  const colourPages = totalColourPages(files);
  const exact = allExact(files);
  const many = files.length > 1;

  const card = useMemo(() => rateCardOf(operator), [operator]);
  const lines = useMemo(() => linesOf(files), [files]);
  const q = useMemo(() => quoteOrder(lines, card), [lines, card]);

  const shared = useMemo(() => sharedConfig(files, sheetConfig), [files, sheetConfig]);

  /**
   * What one option would do to the order total.
   *
   * `scope` is a file index, or "all" for every file at once. Both go through
   * the same pure `quoteOrder`, so the number on the chip is the number the
   * footer will show — not an approximation of it.
   */
  const deltaFor = (scope: number | "all") => (group: Group, value: string | number | string[]) => {
    const next = lines.map((line, i) =>
      scope === "all" || scope === i
        ? { ...line, config: { ...line.config, [group]: value } }
        : line,
    );
    return quoteOrder(next, card).total - q.total;
  };

  const smartNote = (
    <AnimatePresence initial={false}>
      {/* Only meaningful when some page actually carries colour —
          "only 0 have colour" is nonsense. */}
      {shared.config.colour === "smart" &&
        !shared.varies.has("colour") &&
        colourPages > 0 &&
        q.smartSaving > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: "auto", marginTop: 14 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: 0.36, ease: easeIos }}
            className="overflow-hidden"
          >
            <div className="flex gap-[11px] rounded-[14px] bg-sage px-3.5 py-3 text-[12.5px] leading-relaxed text-sage-ink">
              <ShieldCheck size={15} strokeWidth={2.2} className="mt-px shrink-0" />
              <span>
                We checked every page. Only{" "}
                <b className="font-bold">
                  {colourPages} {colourPages === 1 ? "has" : "have"} colour
                </b>{" "}
                — the other {pages - colourPages} print at black &amp; white rates.{" "}
                <b className="font-bold">Saves {money(q.smartSaving, card.currency)}.</b>
              </span>
            </div>
          </motion.div>
        )}
    </AnimatePresence>
  );

  /**
   * Places a real order. There is no payment gateway wired up, so this doesn't
   * pretend to take money: the order lands at `placed`, and the operator moves
   * it to `queued` once they've actually collected the cash or UPI at the
   * desk. That's how the shop works anyway.
   */
  async function placeOrder() {
    setPlacing(true);
    setError(null);
    try {
      const operatorId = await defaultOperatorId();
      if (!operatorId) {
        throw new Error("No operator is set up yet. Run the migrations in supabase/migrations.");
      }

      // No price goes with this. The database prices the same lines from the
      // operator's rate card — see place_order() in migration 0014 — so the
      // figure in the footer is a preview of what it will decide, not an
      // instruction to it.
      await createOrder({
        operatorId,
        pickupAt,
        items: files.map((f) => ({
          documentId: f.localOnly ? null : f.id,
          name: f.name,
          pages: selectedCount(f),
          colourPages: selectedColourCount(f),
          // Empty means every page, which is also how the column defaults.
          selectedPages: f.selectedPages,
          config: f.config,
        })),
      });

      closeSheet();
      clearFiles();
      setStep("upload");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't place the order.");
    } finally {
      setPlacing(false);
    }
  }

  return (
    <>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pt-3.5">
        <button
          onClick={onBack}
          className="mb-2.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft size={14} strokeWidth={2.2} />
          Back to files
        </button>

        <Drawer.Title className="font-figure m-0 mb-1 text-[23px] font-extrabold">
          Print options
        </Drawer.Title>
        <Drawer.Description className="m-0 mb-[18px] text-[13px] text-muted">
          {files.length} {files.length === 1 ? "file" : "files"} · {exact ? "" : "about "}
          {pages} pages ·{" "}
          {colourPages === 0 ? "none need colour" : `${colourPages} contain colour`}
        </Drawer.Description>

        {files.map((file, index) => (
          <FileCard
            key={file.id}
            file={file}
            price={lines[index] ? linePrice(lines[index], lines, card) : 0}
            card={card}
            /* One file is its own settings panel — there is nothing to override
               it against, so the chips below do the job on their own. */
            expandable={many}
            open={openFile === file.id}
            onToggle={() => setOpenFile((v) => (v === file.id ? null : file.id))}
            customised={isCustomised(file, sheetConfig)}
            delta={deltaFor(index)}
            onChange={(key, value) => setFileConfig(file.id, key, value)}
            onReset={() => resetFileConfig(file.id)}
          />
        ))}

        {many && (
          <p className="label-caps m-0 mt-[22px] mb-0.5 text-faint">Applies to every file</p>
        )}

        <ChipGroups
          colourPages={colourPages}
          card={card}
          config={shared.config}
          varies={shared.varies}
          idPrefix="all"
          delta={deltaFor("all")}
          onChange={setConfig}
          smartNote={smartNote}
        />

        <ExtrasRow
          card={card}
          chosen={shared.config.extras ?? []}
          varies={shared.varies.has("extras")}
          copies={shared.config.copies}
          delta={(next) => deltaFor("all")("extras", next)}
          onChange={(next) => setConfig("extras", next)}
        />

        <CopiesPicker
          copies={shared.config.copies}
          varies={shared.varies.has("copies")}
          idPrefix="all"
          onChange={(n) => setConfig("copies", n)}
        />

        <PickupPicker
          operator={operator}
          pages={lines.reduce((n, l) => n + l.pages * l.config.copies, 0)}
          value={pickupAt}
          onChange={setPickupAt}
        />

        <div className="h-2" />
      </div>

      <div className="shrink-0 border-t border-line bg-paper/[0.92] px-[18px] pt-3.5 pb-[max(18px,env(safe-area-inset-bottom))] backdrop-blur-xl">
        {/* The arithmetic behind the number, one tap away. Same function that
            prices it in the database, so this is the bill, not an estimate. */}
        <AnimatePresence initial={false}>
          {showBill && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: easeIos }}
              className="overflow-hidden"
            >
              <div className="mb-3 max-h-[38dvh] overflow-y-auto rounded-[14px] border border-line bg-surface px-3.5 py-3">
                <Bill quote={q} card={card} names={files.map((f) => f.name)} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mb-3 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <button
              onClick={() => setShowBill((v) => !v)}
              aria-expanded={showBill}
              className="label-caps m-0 flex items-center gap-1 text-left"
            >
              Total
              <ChevronDown
                size={12}
                strokeWidth={2.4}
                className={cn("transition-transform", showBill && "rotate-180")}
              />
              <span className="ml-1 font-normal normal-case tracking-normal text-faint">
                {showBill ? "hide bill" : "see bill"}
              </span>
            </button>
            <p className="m-0 mt-0.5 truncate font-mono text-[11px] text-muted">
              {describeOrder(q, lines)}
            </p>
          </div>
          <Figure value={q.total} prefix={card.currency} className="shrink-0 text-[32px] font-extrabold" />
        </div>

        {q.minApplied && (
          <p className="m-0 mb-2.5 text-[11px] leading-snug text-muted">
            {money(card.minOrder, card.currency)} is this operator&apos;s minimum for a job.
          </p>
        )}

        {!exact && (
          <p className="m-0 mb-2.5 text-[11px] leading-snug text-muted">
            Some page counts are estimates until we convert the file. The operator confirms the
            total before printing.
          </p>
        )}

        {error && (
          <p className="m-0 mb-2.5 flex items-start gap-2 rounded-xl bg-clay px-3 py-2.5 text-[11.5px] leading-snug text-clay-ink">
            <AlertCircle size={14} strokeWidth={2.2} className="mt-px shrink-0" />
            {error}
          </p>
        )}

        <motion.button
          whileTap={{ scale: closed ? 1 : 0.98 }}
          transition={spring}
          disabled={placing || closed}
          onClick={placeOrder}
          className={cn(
            "flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold",
            closed ? "border border-line bg-surface text-muted" : "bg-ink text-paper",
          )}
        >
          {closed ? (
            "Printifi is closed"
          ) : placing ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Placing your order…
            </>
          ) : (
            <>
              Send to operator
              <ArrowRight size={17} strokeWidth={2.2} />
            </>
          )}
        </motion.button>

        <p className="m-0 mt-2.5 text-center text-[11px] leading-snug text-muted">
          {closed
            ? (operator?.status_note?.trim() ??
              "Your files stay here — send them as soon as Printifi opens.")
            : pickupAt
              ? `Ready by ${new Date(pickupAt).toLocaleString([], {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}. Pay ${money(q.total, card.currency)} when you collect.`
              : `Pay ${money(q.total, card.currency)} when you collect. You'll get a token as soon as the order is placed.`}
        </p>
      </div>
    </>
  );
}

/** How a file's settings read at a glance, in the order a person says them. */
function summarise(config: PrintConfig): string {
  return [
    config.colour === "smart" ? "smart colour" : config.colour === "bw" ? "black & white" : "full colour",
    config.sides === "double" ? "both sides" : "one side",
    config.binding === "staple" ? "stapled" : "loose",
    config.copies > 1 ? `${config.copies} copies` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One file in the job, with its own settings behind a disclosure.
 *
 * Collapsed it is the row that was always here plus two things it never had:
 * what this file is set to, and what it costs on its own. Nothing is hidden
 * that used to be visible.
 */
function FileCard({
  file,
  price,
  card,
  expandable,
  open,
  onToggle,
  customised,
  delta,
  onChange,
  onReset,
}: {
  file: UploadFile;
  price: number;
  card: RateCard;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
  customised: boolean;
  delta: (group: Group, value: string | number | string[]) => number;
  onChange: <K extends Group>(key: K, value: PrintConfig[K]) => void;
  onReset: () => void;
}) {
  const pages = selectedCount(file);
  const colourPages = selectedColourCount(file);

  return (
    <div className="mb-2 rounded-[14px] border border-line bg-surface">
      <div className="flex items-center gap-[11px] px-3.5 py-[11px]">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] border border-line bg-surface-sunk font-mono text-[9px] font-medium text-muted">
          {file.kind}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em]">
            {file.name}
          </span>
          {expandable && (
            <span className="mt-0.5 block truncate font-mono text-[10.5px] text-muted">
              {summarise(file.config)}
              {customised && <span className="ml-1.5 font-sans font-semibold">· its own</span>}
            </span>
          )}
        </span>

        <span className="shrink-0 text-right">
          <span className="block font-mono text-[11.5px] whitespace-nowrap text-muted">
            {file.pagesExact ? "" : "≈"}
            {pages} p
          </span>
          {expandable && (
            <span className="block font-mono text-[11.5px] whitespace-nowrap">
              {money(price, card.currency)}
            </span>
          )}
        </span>

        {expandable && (
          <button
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`Settings for ${file.name}`}
            className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-sunk text-muted transition-colors hover:text-ink"
          >
            <ChevronDown
              size={15}
              strokeWidth={2.2}
              className={cn("transition-transform", open && "rotate-180")}
            />
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: easeIos }}
            className="overflow-hidden"
          >
            <div className="border-t border-line px-3.5 pt-0.5 pb-3.5">
              <ChipGroups
                colourPages={colourPages}
                card={card}
                config={file.config}
                varies={EMPTY_VARIES}
                idPrefix={file.id}
                delta={delta}
                onChange={onChange}
              />

              <ExtrasRow
                card={card}
                chosen={file.config.extras ?? []}
                varies={false}
                copies={file.config.copies}
                delta={(next) => delta("extras", next)}
                onChange={(next) => onChange("extras", next)}
              />

              <CopiesPicker
                copies={file.config.copies}
                varies={false}
                idPrefix={file.id}
                onChange={(n) => onChange("copies", n)}
              />

              {customised && (
                <button
                  onClick={onReset}
                  className="mt-3.5 flex items-center gap-1.5 text-[12px] font-semibold text-muted transition-colors hover:text-ink"
                >
                  <RotateCcw size={13} strokeWidth={2.2} />
                  Match the other files
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A single file never disagrees with itself. */
const EMPTY_VARIES: Set<Group> = new Set();
