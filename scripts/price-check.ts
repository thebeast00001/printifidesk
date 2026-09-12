import {
  quote, quoteOrder, linePrice, describeOrder, rateCardOf, money, paise, DEFAULT_CONFIG,
} from "../lib/pricing";
import type { QuoteLine } from "../lib/pricing";

// Two operators with deliberately different rates — the point of the change.
const cheap = rateCardOf({
  currency: "₹", bw_per_page: "1.00", colour_per_page: "6.00",
  duplex_discount: "0.10", staple_price: "3.00",
  bulk_threshold: 100, bulk_multiplier: "0.90", min_order: "10", paper_gsm: 70,
});
const premium = rateCardOf({
  currency: "₹", bw_per_page: "2.00", colour_per_page: "12.00",
  duplex_discount: "0", staple_price: "10.00",
  bulk_threshold: 50, bulk_multiplier: "0.80", min_order: "0", paper_gsm: 100,
});

const job = { pages: 48, colour: 4 };
for (const [name, card] of [["cheap", cheap], ["premium", premium]] as const) {
  const smart = quote(job.pages, job.colour, { ...DEFAULT_CONFIG, binding: "staple" }, card);
  const full  = quote(job.pages, job.colour, { ...DEFAULT_CONFIG, colour: "full", binding: "staple" }, card);
  console.log(
    `${name.padEnd(8)} smart=${money(smart.total, card.currency).padEnd(6)}` +
    ` full=${money(full.total, card.currency).padEnd(6)}` +
    ` saves=${money(smart.smartSaving, card.currency)}`
  );
}

// Hand-check the cheap operator: 44 b/w + 4 colour, duplex, stapled. To the
// paisa — the operator wrote ₹1.00 and ₹6.00 and a 10% duplex discount, and
// (44 + 24) × 0.9 + 3 is 64.20, not 64.
const c = quote(48, 4, { ...DEFAULT_CONFIG, binding: "staple" }, cheap);
const expected = paise((44 * 1 + 4 * 6) * (1 - 0.10) + 3);
console.log(`\ncheap hand-check: engine=${c.total} expected=${expected} ${c.total === expected ? "OK" : "MISMATCH"}`);

// Minimum order must lift a tiny job.
if (c.total !== expected) process.exitCode = 1;

const tiny = quote(1, 0, { ...DEFAULT_CONFIG, binding: "none" }, cheap);
console.log(`min order: 1 page -> ${money(tiny.total, cheap.currency)} minApplied=${tiny.minApplied} ${tiny.total === 10 ? "OK" : "MISMATCH"}`);

// Bulk slab must engage past the threshold.
const under = quote(99, 0, DEFAULT_CONFIG, cheap);
const over  = quote(100, 0, DEFAULT_CONFIG, cheap);
console.log(`bulk: 99p=${under.total} 100p=${over.total} bulkSaving@100=${over.bulkSaving} ${over.bulkSaving > 0 && under.bulkSaving === 0 ? "OK" : "MISMATCH"}`);


// ---------------------------------------------------------------
// Per-file settings (0013). The single-config `quote()` above must keep
// behaving exactly as it did — everything here is the multi-line form.
// ---------------------------------------------------------------
let bad = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(42)} ${detail}`);
};

console.log("\n— per-file settings —");

// One line through quoteOrder must equal quote(). If these ever diverge, every
// price in the app silently changes.
const oneLine: QuoteLine = {
  pages: 48, colourPages: 4, config: { ...DEFAULT_CONFIG, binding: "staple" },
};
check(
  "one line equals the single-config form",
  quoteOrder([oneLine], cheap).total === quote(48, 4, oneLine.config, cheap).total,
  `${quoteOrder([oneLine], cheap).total}`,
);

// A stapled report beside a loose handout: the staple is charged once, on the
// file that is actually stapled.
const report: QuoteLine = { pages: 40, colourPages: 0, config: { ...DEFAULT_CONFIG, binding: "staple" } };
const handout: QuoteLine = { pages: 2, colourPages: 2, config: { ...DEFAULT_CONFIG, binding: "none", colour: "full" } };
const mixed = quoteOrder([report, handout], cheap);
const separately = linePrice(report, [report, handout], cheap) + linePrice(handout, [report, handout], cheap);
check("per-file binding is charged once", mixed.total === separately, `${mixed.total} = ${separately}`);
check(
  "one staple, not two",
  mixed.binding === cheap.staplePrice,
  `binding=${mixed.binding} staple=${cheap.staplePrice}`,
);

// The bulk slab is a property of the job, not of any one file: 60 + 60 is a
// 120-page job and must reach the threshold neither half reaches alone.
const half: QuoteLine = { pages: 60, colourPages: 0, config: DEFAULT_CONFIG };
const both = quoteOrder([half, half], cheap);
check(
  "bulk counts the whole job, not each file",
  both.bulkSaving > 0 && quoteOrder([half], cheap).bulkSaving === 0,
  `two halves save ${both.bulkSaving}, one saves ${quoteOrder([half], cheap).bulkSaving}`,
);

// Copies are per file too, and they count toward the slab.
const threeCopies: QuoteLine = { pages: 40, colourPages: 0, config: { ...DEFAULT_CONFIG, copies: 3 } };
check(
  "copies count toward the slab",
  quoteOrder([threeCopies], cheap).bulkSaving > 0,
  `120 printed pages from 40 x 3`,
);

// A file the student set to black & white saved them money, but not because of
// smart colour. Claiming it would overstate what the feature did.
const chosenBw: QuoteLine = { pages: 20, colourPages: 20, config: { ...DEFAULT_CONFIG, colour: "bw" } };
check(
  "smart saving ignores a deliberate b/w file",
  quoteOrder([chosenBw], cheap).smartSaving === 0,
  `saving=${quoteOrder([chosenBw], cheap).smartSaving}`,
);

const smartLine: QuoteLine = { pages: 20, colourPages: 3, config: DEFAULT_CONFIG };
check(
  "smart saving still counts a smart file",
  quoteOrder([smartLine, chosenBw], cheap).smartSaving > 0,
  `saving=${quoteOrder([smartLine, chosenBw], cheap).smartSaving}`,
);

// The minimum applies once to the order, not once per file.
const crumb: QuoteLine = { pages: 1, colourPages: 0, config: { ...DEFAULT_CONFIG, binding: "none" } };
check(
  "minimum applies once per order",
  quoteOrder([crumb, crumb, crumb], cheap).total === 10,
  `${quoteOrder([crumb, crumb, crumb], cheap).total} with a ${cheap.minOrder} minimum`,
);

// The summary has to name what differs rather than saying "mixed".
check(
  "summary names what differs",
  describeOrder(quoteOrder([report, handout], cheap), [report, handout]).includes("binding"),
  describeOrder(quoteOrder([report, handout], cheap), [report, handout]),
);
check(
  "identical files read as one job",
  !describeOrder(quoteOrder([half, half], cheap), [half, half]).includes("differ"),
  describeOrder(quoteOrder([half, half], cheap), [half, half]),
);

console.log("\n— the bill adds up (to the paisa, for every job in a grid) —");
{
  const awkward = rateCardOf({
    currency: "₹", bw_per_page: "1.35", colour_per_page: "7.75", duplex_discount: "0.08",
    staple_price: "4.50", bulk_threshold: 60, bulk_multiplier: "0.9", min_order: "10", paper_gsm: 80,
    // The platform's share, with a decimal of its own so its rounding is real.
    platform_fee_percent: "3.25", platform_fee_min: "0",
  });
  let jobs = 0;
  let linesOff = 0;
  let partsOff = 0;
  let nonPaise = 0;
  for (const pages of [1, 3, 7, 23, 48, 61, 120]) {
    for (const colour of ["smart", "bw", "full"] as const) {
      for (const sides of ["single", "double"] as const) {
        for (const binding of ["none", "staple"] as const) {
          for (const copies of [1, 3]) {
            const colourPages = Math.floor(pages / 3);
            const q = quoteOrder(
              [
                { pages, colourPages, config: { colour, sides, binding, copies } },
                { pages: 5, colourPages: 1, config: DEFAULT_CONFIG },
              ],
              awkward,
            );
            jobs++;
            // Every amount is a whole number of paise.
            for (const v of [q.total, q.subtotal, q.topUp, q.platformFee, ...q.lines.map((l) => l.price)]) {
              if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) nonPaise++;
            }
            // Lines sum to the subtotal; subtotal, top-up and fee are the total,
            // and the fee is the percentage of what sits under it.
            const lineSum = paise(q.lines.reduce((n, l) => n + l.price, 0));
            const base = paise(q.subtotal + q.topUp);
            if (lineSum !== q.subtotal || paise(base + q.platformFee) !== q.total) linesOff++;
            if (q.platformFee !== paise((base * 3.25) / 100)) linesOff++;
            // Each line's parts sum to that line's price.
            for (const l of q.lines) {
              const parts = paise(l.bwCost + l.colourCost - l.bulkSaving - l.duplexSaving + l.binding);
              if (parts !== l.price) partsOff++;
            }
          }
        }
      }
    }
  }
  check("every amount is whole paise", nonPaise === 0, `${nonPaise} off`);
  check("lines sum to the total, every job", linesOff === 0, `${linesOff} off`);
  check("parts sum to each line, every job", partsOff === 0, `${partsOff} off`);
  console.log(`   ${jobs} jobs checked`);

  // The top-up is shown as a line, not hidden in the total.
  const small = quoteOrder([{ pages: 1, colourPages: 0, config: DEFAULT_CONFIG }], awkward);
  check("minimum shows as a top-up line", small.topUp === paise(10 - small.subtotal), `${small.subtotal} + ${small.topUp}`);
  // The fee sits on the lifted amount: ₹10 × 3.25% = ₹0.325 → ₹0.33 (half-up, like the SQL).
  check("fee on the lifted minimum", small.platformFee === 0.33 && small.total === 10.33, `${small.platformFee} → ${small.total}`);
  // A floor replaces a smaller percentage; a zero card means no fee at all.
  const floored = rateCardOf({ bw_per_page: "1.5", platform_fee_percent: "3", platform_fee_min: "1" });
  const flooredFee = quoteOrder([{ pages: 2, colourPages: 0, config: { ...DEFAULT_CONFIG, sides: "single", colour: "bw" } }], floored).platformFee;
  check("minimum fee floors a small order", flooredFee === 1, `${flooredFee}`);
  const feeless = rateCardOf({ bw_per_page: "1.5" });
  const noFee = quoteOrder([{ pages: 20, colourPages: 0, config: DEFAULT_CONFIG }], feeless).platformFee;
  check("no fee configured means none charged", noFee === 0, `${noFee}`);
  check(
    "money shows paise only when present",
    money(4.5) === "₹4.50" && money(5) === "₹5" && money(64.2) === "₹64.20",
    `${money(4.5)}, ${money(5)}, ${money(64.2)}`,
  );

  // A desk that rounds: the same jobs, every total whole, the lines and the
  // fee untouched, and what was added shown as its own line.
  const rounding = rateCardOf({
    bw_per_page: "1.35", colour_per_page: "7.75", duplex_discount: "0.08", staple_price: "4.50",
    bulk_threshold: 60, bulk_multiplier: "0.9", min_order: "10", paper_gsm: 80,
    platform_fee_percent: "3.25", platform_fee_min: "0", round_to_rupee: true,
  });
  let notWhole = 0;
  let lineDrift = 0;
  let feeDrift = 0;
  let roundingOff = 0;
  let lifted = 0;
  for (const pages of [1, 7, 23, 48, 61, 120]) {
    for (const colour of ["smart", "bw", "full"] as const) {
      for (const copies of [1, 3]) {
        const lines: QuoteLine[] = [
          { pages, colourPages: Math.floor(pages / 3), config: { ...DEFAULT_CONFIG, colour, copies } },
          { pages: 5, colourPages: 1, config: { ...DEFAULT_CONFIG, colour: "bw", sides: "single" } },
        ];
        const r = quoteOrder(lines, rounding);
        const u = quoteOrder(lines, awkward);
        if (!Number.isInteger(r.total)) notWhole++;
        if (r.lines.some((l, i) => l.price !== u.lines[i].price)) lineDrift++;
        if (r.platformFee !== u.platformFee) feeDrift++;
        if (paise(u.total + r.rounding) !== r.total || r.rounding < 0 || r.rounding >= 1) roundingOff++;
        if (r.rounding > 0) lifted++;
      }
    }
  }
  check("rounded: every total is whole", notWhole === 0, `${notWhole} not whole`);
  check("rounded: lines identical", lineDrift === 0, `${lineDrift} drifted`);
  check("rounded: fee identical", feeDrift === 0, `${feeDrift} drifted`);
  check("rounded: the line is exactly what was added", roundingOff === 0, `${roundingOff} off, ${lifted} lifted`);
}

console.log(bad === 0 ? "\nPASS - pricing" : `\nFAIL - ${bad} pricing check(s)`);
process.exit(bad === 0 ? 0 : 1);
