"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Clock, Images, ScanLine, Upload } from "lucide-react";
import { useUploader } from "@/hooks/use-uploader";
import { ACCEPTED_EXTENSIONS, CONVERTS_OFFICE } from "@/lib/analysis";
import { useApp } from "@/lib/store";
import { useOperatorWait } from "@/hooks/use-tracking";
import { perPage, rateCardOf } from "@/lib/pricing";
import { cn, spring } from "@/lib/utils";

export function UploadCard() {
  const openSheet = useApp((s) => s.openSheet);
  const { accept } = useUploader();
  // Rates belong to whoever is printing, so they're read, never hardcoded.
  const { operator, ready: ratesReady } = useOperatorWait();
  const card = rateCardOf(operator);

  const filePicker = useRef<HTMLInputElement>(null);
  const cameraPicker = useRef<HTMLInputElement>(null);
  const photoPicker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  function take(files: FileList | null) {
    if (!files?.length) return;
    void accept(files);
    openSheet("upload");
  }

  return (
    <section data-anim="upload">
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current += 1;
          setOver(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          depth.current -= 1;
          if (depth.current <= 0) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          take(e.dataTransfer.files);
        }}
        className={cn(
          "rounded-[26px] border bg-surface p-[18px] shadow-card transition-colors lg:p-6",
          over ? "border-ink bg-surface-sunk" : "border-line",
        )}
      >
        <div className="flex items-start gap-3.5">
          <div className="flex-1">
            <h3 className="font-heading m-0 mb-2.5 text-lg font-bold">
              {over ? "Drop them anywhere here" : "Send something to print"}
            </h3>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[12.5px] text-muted">
              <li>
                {ratesReady && operator ? (
                  <>
                    <b className="font-semibold text-ink-soft">
                      {perPage(card.bwPerPage, card.currency)}
                    </b>{" "}
                    black &amp; white ·{" "}
                    <b className="font-semibold text-ink-soft">
                      {perPage(card.colourPerPage, card.currency)}
                    </b>{" "}
                    colour
                  </>
                ) : (
                  <span className="text-faint">Loading today&apos;s rates…</span>
                )}
              </li>
              <li>
                {card.paperGsm} GSM paper ·{" "}
                <b className="font-semibold text-ink-soft">
                  {card.duplexDiscount > 0
                    ? `${Math.round(card.duplexDiscount * 100)}% off both sides`
                    : "duplex included"}
                </b>
              </li>
              <li>
                {CONVERTS_OFFICE ? "PDF, Word, PowerPoint, photos" : "PDF or photos"} — <b className="font-semibold text-ink-soft">pages counted here</b>, before you pay
              </li>
            </ul>
          </div>
          <SheetStack lifted={over} />
        </div>

        <input
          ref={filePicker}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(",")}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
          className="sr-only"
        />
        <input
          ref={cameraPicker}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
          className="sr-only"
        />
        <input
          ref={photoPicker}
          type="file"
          multiple
          accept="image/*"
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
          className="sr-only"
        />

        <motion.button
          whileTap={{ scale: 0.975 }}
          transition={spring}
          onClick={() => filePicker.current?.click()}
          className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-[14px] bg-ink text-[14.5px] font-semibold tracking-[-0.01em] text-paper"
        >
          <Upload size={17} strokeWidth={2.2} />
          Upload files
        </motion.button>

        <div className="mt-2.5 flex gap-2">
          <QuickSource icon={ScanLine} label="Scan" onClick={() => cameraPicker.current?.click()} />
          <QuickSource icon={Images} label="Photos" onClick={() => photoPicker.current?.click()} />
          <QuickSource
            icon={Clock}
            label="Stored"
            onClick={() =>
              document.getElementById("feed")?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          />
        </div>
      </div>
    </section>
  );
}

function QuickSource({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
      className="flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-sunk text-[12.5px] font-semibold text-ink-soft transition-colors hover:bg-line/50"
    >
      <Icon size={14} strokeWidth={2.1} />
      <span className="truncate">{label}</span>
    </motion.button>
  );
}

/** Three sheets fanned out — the pile you'd hand over the desk. */
function SheetStack({ lifted }: { lifted: boolean }) {
  return (
    <motion.div
      animate={{ scale: lifted ? 1.06 : 1, rotate: lifted ? -3 : 0 }}
      transition={spring}
      className="relative size-[62px] h-[74px] shrink-0"
      aria-hidden
    >
      <i className="absolute inset-0 -translate-x-1 translate-y-[3px] -rotate-9 rounded-[5px] border border-line-strong bg-surface-sunk" />
      <i className="absolute inset-0 translate-x-[3px] -translate-y-px rotate-[5deg] rounded-[5px] bg-bone" />
      <i className="absolute inset-0 rounded-[5px] border border-line-strong bg-surface shadow-card" />
      <span className="absolute inset-x-2.5 inset-y-3 flex flex-col gap-1">
        {[100, 76, 88, 58, 92].map((w, i) => (
          <b key={i} style={{ width: `${w}%` }} className="block h-0.5 rounded-sm bg-line-strong" />
        ))}
      </span>
    </motion.div>
  );
}
