import {
  quote, quoteOrder, linePrice, describeOrder, rateCardOf, money, DEFAULT_CONFIG,
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

// Hand-check the cheap operator: 44 b/w + 4 colour, duplex, stapled.
const c = quote(48, 4, { ...DEFAULT_CONFIG, binding: "staple" }, cheap);
const expected = Math.round((((44 * 1 + 4 * 6) * 1) * (1 - 0.10) + 3) * 1);
console.log(`\ncheap hand-check: engine=${c.total} expected=${expected} ${c.total === expected ? "OK" : "MISMATCH"}`);

// Minimum order must lift a tiny job.
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

console.log(bad === 0 ? "\nPASS - pricing" : `\nFAIL - ${bad} pricing check(s)`);
process.exit(bad === 0 ? 0 : 1);
