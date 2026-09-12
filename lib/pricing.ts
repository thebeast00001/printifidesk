/**
 * Pricing engine.
 *
 * The rate card belongs to the operator, not to this file — a hostel desk and a
 * library desk charge differently, and the person running the machine is the
 * one who knows what their paper and toner cost. Everything here is pure, so
 * the same function prices the live quote in the browser and can re-price the
 * order server-side before money changes hands.
 */

export type ColourMode = "smart" | "bw" | "full";
export type Sides = "single" | "double";
/** What a desk can do while you wait. Anything else is a separate job. */
export type Binding = "none" | "staple";

export interface PrintConfig {
  colour: ColourMode;
  sides: Sides;
  binding: Binding;
  copies: number;
}

export interface RateCard {
  currency: string;
  bwPerPage: number;
  colourPerPage: number;
  /** Share taken off when both sides of a sheet are used, 0–1. */
  duplexDiscount: number;
  staplePrice: number;
  /** At or above this many pages, paper cost is multiplied by bulkMultiplier. */
  bulkThreshold: number;
  bulkMultiplier: number;
  minOrder: number;
  paperGsm: number;
  /**
   * Printify's share, a percentage of the order after the minimum. Not the
   * desk's to set: it comes from platform_settings, is merged onto the
   * operator row when it's fetched, and is snapshotted onto every order.
   */
  platformFeePercent: number;
  /** A floor per order, so a ₹6 job doesn't show a fee of ₹0.18. */
  platformFeeMin: number;
}

/** Shape of the operator row the rate card is read from. */
export interface RateSource {
  currency?: string | null;
  bw_per_page?: number | string | null;
  colour_per_page?: number | string | null;
  duplex_discount?: number | string | null;
  staple_price?: number | string | null;
  bulk_threshold?: number | null;
  bulk_multiplier?: number | string | null;
  min_order?: number | string | null;
  paper_gsm?: number | null;
  platform_fee_percent?: number | string | null;
  platform_fee_min?: number | string | null;
}

const num = (v: number | string | null | undefined, fallback: number) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

/**
 * Postgres returns numerics as strings over PostgREST, so every rate is coerced
 * rather than trusted. The fallbacks are only reached for a row that predates
 * migration 0005.
 */
export function rateCardOf(operator: RateSource | null | undefined): RateCard {
  return {
    currency: operator?.currency?.trim() || "₹",
    bwPerPage: num(operator?.bw_per_page, 1.5),
    colourPerPage: num(operator?.colour_per_page, 8),
    duplexDiscount: num(operator?.duplex_discount, 0.08),
    staplePrice: num(operator?.staple_price, 5),
    bulkThreshold: operator?.bulk_threshold ?? 100,
    bulkMultiplier: num(operator?.bulk_multiplier, 0.92),
    minOrder: num(operator?.min_order, 0),
    paperGsm: operator?.paper_gsm ?? 80,
    // No fee unless one is configured — an old snapshot, or a project that
    // hasn't run 0022, prices exactly as it did before.
    platformFeePercent: num(operator?.platform_fee_percent, 0),
    platformFeeMin: num(operator?.platform_fee_min, 0),
  };
}

/**
 * The platform fee on a base amount: base × percent ÷ 100 to the paisa,
 * then the floor. Zero on nothing. The database does the same arithmetic in
 * double precision, in this order — see platform_fee_for() in 0022.
 */
export function platformFeeOn(base: number, card: RateCard): number {
  if (base <= 0) return 0;
  return Math.max(paise((base * card.platformFeePercent) / 100), paise(card.platformFeeMin));
}

/**
 * Money is kept to the paisa, and the display shows paise only when there
 * are any. An operator who sets ₹1.50 a page means ₹4.50 for three pages,
 * not ₹5 — the first version of this rounded the order to whole rupees and
 * quietly charged more than the rate card said.
 */
export const paise = (x: number) => Math.round(x * 100) / 100;

/** One file's bill: the parts a student can check against the rate card. */
export interface LineBill {
  pages: number;
  colourPages: number;
  config: PrintConfig;
  /** Pages charged at each rate, for one copy. */
  bwPages: number;
  inkedPages: number;
  /** Rupees, all copies, each to the paisa. These sum exactly to `price`. */
  bwCost: number;
  colourCost: number;
  bulkSaving: number;
  duplexSaving: number;
  binding: number;
  price: number;
}

export interface Quote {
  bwPages: number;
  colourPages: number;
  paper: number;
  binding: number;
  duplexSaving: number;
  bulkSaving: number;
  /** The files, each with its own arithmetic laid out. */
  lines: LineBill[];
  /** Sum of the line prices, before the minimum. */
  subtotal: number;
  /** What the minimum order added, if it did. */
  topUp: number;
  /** Printify's share, on top of the lines and the top-up. */
  platformFee: number;
  total: number;
  /** What full colour would have cost — the smart-colour pitch. */
  fullColourTotal: number;
  smartSaving: number;
  /** True when the minimum order value lifted the price. */
  minApplied: boolean;
  /** Whether the bulk slab applied, and what it takes off. */
  bulkApplied: boolean;
  bulkPercent: number;
}

export const DEFAULT_CONFIG: PrintConfig = {
  colour: "smart",
  sides: "double",
  binding: "none",
  copies: 1,
};

/** One file, with the settings chosen for that file. */
export interface QuoteLine {
  pages: number;
  colourPages: number;
  config: PrintConfig;
}

interface LineCost {
  bwPages: number;
  inkedPages: number;
  /** List price of the paper for one copy, before any discount. */
  bwList: number;
  colourList: number;
  paper: number;
  binding: number;
  duplexSaving: number;
  bulkSaving: number;
  raw: number;
}

/**
 * What one file costs, before the order minimum.
 *
 * `bulk` is passed in rather than derived, because the bulk slab is a property
 * of the whole job — printing 60 pages and 60 more is a 120-page job, and
 * charging each half at the small-job rate would be wrong.
 */
function lineCost(
  pages: number,
  colourPages: number,
  config: PrintConfig,
  card: RateCard,
  bulk: number,
): LineCost {
  const { colour, sides, binding, copies } = config;

  const bwPages = colour === "full" ? 0 : colour === "bw" ? pages : pages - colourPages;
  const inkedPages = colour === "full" ? pages : colour === "bw" ? 0 : colourPages;

  const listPaper = bwPages * card.bwPerPage + inkedPages * card.colourPerPage;
  const bulkSaving = listPaper * (1 - bulk);

  const afterBulk = listPaper * bulk;
  const duplexSaving = sides === "double" ? afterBulk * card.duplexDiscount : 0;
  const paper = afterBulk - duplexSaving;

  const bind = binding === "staple" ? card.staplePrice : 0;

  return {
    bwPages: bwPages * copies,
    inkedPages: inkedPages * copies,
    bwList: bwPages * card.bwPerPage,
    colourList: inkedPages * card.colourPerPage,
    paper: paper * copies,
    binding: bind * copies,
    duplexSaving: duplexSaving * copies,
    bulkSaving: bulkSaving * copies,
    raw: (paper + bind) * copies,
  };
}

/**
 * The parts of one line, each to the paisa, made to sum exactly to the
 * line's price. Rounding five parts separately can drift a paisa or two from
 * rounding their sum; the drift is put on the largest part, so a student who
 * adds the bill up by hand lands on the number they were charged.
 */
function lineBill(line: QuoteLine, cost: LineCost, copies: number): LineBill {
  const price = paise(cost.raw);
  const parts = {
    bwCost: paise(cost.bwList * copies),
    colourCost: paise(cost.colourList * copies),
    bulkSaving: paise(cost.bulkSaving),
    duplexSaving: paise(cost.duplexSaving),
    binding: paise(cost.binding),
  };
  const summed = paise(parts.bwCost + parts.colourCost - parts.bulkSaving - parts.duplexSaving + parts.binding);
  const drift = paise(price - summed);
  if (drift !== 0) {
    const key = (["bwCost", "colourCost", "binding"] as const).reduce((a, b) =>
      parts[a] >= parts[b] ? a : b,
    );
    parts[key] = paise(parts[key] + drift);
  }
  return {
    pages: line.pages,
    colourPages: line.colourPages,
    config: line.config,
    bwPages: cost.bwPages / copies,
    inkedPages: cost.inkedPages / copies,
    ...parts,
    price,
  };
}

/** Pages that actually go through the machine, which is what the slab counts. */
const printedPages = (lines: QuoteLine[]) =>
  lines.reduce((n, l) => n + l.pages * l.config.copies, 0);

/**
 * Prices a whole order, one line per file.
 *
 * Binding and copies are per file — a stapled 40-page report next to a single
 * loose handout is one order with two different answers — while the bulk slab
 * and the minimum order are properties of the job as a whole.
 */
export function quoteOrder(lines: QuoteLine[], card: RateCard): Quote {
  const bulkApplied = printedPages(lines) >= card.bulkThreshold;
  const bulk = bulkApplied ? card.bulkMultiplier : 1;
  const minOrder = paise(card.minOrder);

  const costs = lines.map((l) => lineCost(l.pages, l.colourPages, l.config, card, bulk));
  const bills = lines.map((l, i) => lineBill(l, costs[i], Math.max(1, l.config.copies)));
  const sum = (pick: (c: LineCost) => number) => costs.reduce((n, c) => n + pick(c), 0);

  // The total is the sum of the line prices as shown — not the rounded sum
  // of the unrounded lines — so a bill always adds up. The database does the
  // same, in the same order; the harness compares them line by line.
  const subtotal = paise(bills.reduce((n, b) => n + b.price, 0));
  const base = Math.max(subtotal, minOrder);
  const topUp = paise(base - subtotal);
  // The minimum lifts the lines; the fee sits on top of that.
  const platformFee = platformFeeOn(base, card);
  const total = paise(base + platformFee);

  // What the same job would have cost printed entirely in colour. Used by the
  // savings widget, so every line counts regardless of what it was set to.
  const fullColourSum = paise(
    lines
      .map((l) => paise(lineCost(l.pages, l.pages, { ...l.config, colour: "full" }, card, bulk).raw))
      .reduce((n, v) => n + v, 0),
  );
  const fullColourBase = Math.max(fullColourSum, minOrder);
  const fullColourTotal = paise(fullColourBase + platformFeeOn(fullColourBase, card));

  // The smart-colour claim only counts lines actually set to smart. A line the
  // student deliberately set to black & white saved them money, but not by
  // anything this feature did, and claiming it would be a lie.
  const smartSum = paise(
    lines
      .map((l) =>
        paise(
          l.config.colour === "smart"
            ? lineCost(l.pages, l.pages, { ...l.config, colour: "full" }, card, bulk).raw
            : lineCost(l.pages, l.colourPages, l.config, card, bulk).raw,
        ),
      )
      .reduce((n, v) => n + v, 0),
  );
  const smartBase = Math.max(smartSum, minOrder);
  const smartTotal = paise(smartBase + platformFeeOn(smartBase, card));

  return {
    bwPages: sum((c) => c.bwPages),
    colourPages: sum((c) => c.inkedPages),
    paper: paise(sum((c) => c.paper)),
    binding: paise(sum((c) => c.binding)),
    duplexSaving: paise(sum((c) => c.duplexSaving)),
    bulkSaving: paise(sum((c) => c.bulkSaving)),
    lines: bills,
    subtotal,
    topUp,
    platformFee,
    total,
    fullColourTotal,
    smartSaving: Math.max(0, paise(smartTotal - total)),
    minApplied: subtotal < minOrder,
    bulkApplied,
    bulkPercent: Math.round((1 - card.bulkMultiplier) * 100),
  };
}

/** The single-config form: one line covering the whole job. */
export function quote(
  totalPages: number,
  colourPages: number,
  config: PrintConfig,
  card: RateCard,
): Quote {
  return quoteOrder([{ pages: totalPages, colourPages, config }], card);
}

/** What one file costs on its own, for the per-item price stored on the order. */
export function linePrice(line: QuoteLine, lines: QuoteLine[], card: RateCard): number {
  const bulk = printedPages(lines) >= card.bulkThreshold ? card.bulkMultiplier : 1;
  return paise(lineCost(line.pages, line.colourPages, line.config, card, bulk).raw);
}

/** Reads back the way a person would describe their own order. */
export function describe(q: Quote, config: PrintConfig): string {
  const parts: string[] = [];
  if (q.bwPages && q.colourPages) parts.push(`${q.bwPages} b/w + ${q.colourPages} colour`);
  else if (q.colourPages) parts.push(`${q.colourPages} pages colour`);
  else parts.push(`${q.bwPages} pages b/w`);

  if (config.binding === "staple") parts.push("stapled");
  if (config.copies > 1) parts.push(`${config.copies} copies`);
  return parts.join(" + ");
}

/**
 * The same summary when the files disagree.
 *
 * Naming what differs is the point: "mixed settings" tells a student nothing,
 * whereas "2 files · sides and copies differ" tells them exactly where to look.
 */
export function describeOrder(q: Quote, lines: QuoteLine[]): string {
  if (lines.length === 0) return "";
  if (lines.length === 1) return describe(q, lines[0].config);

  const varies = (key: keyof PrintConfig) =>
    lines.some((l) => l.config[key] !== lines[0].config[key]);

  const differing = (["colour", "sides", "binding", "copies"] as const)
    .filter(varies)
    .map((k) => (k === "colour" ? "colour" : k === "sides" ? "sides" : k));

  const head = describe(q, lines[0].config);
  if (differing.length === 0) return head;

  const list =
    differing.length === 1
      ? differing[0]
      : `${differing.slice(0, -1).join(", ")} and ${differing[differing.length - 1]}`;
  return `${lines.length} files · ${list} differ`;
}

export function money(amount: number, currency = "₹") {
  const rounded = paise(amount);
  const whole = Number.isInteger(rounded);
  return `${currency}${rounded.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Per-page rate shown on a chip, trimmed of pointless decimals. */
export function perPage(rate: number, currency = "₹") {
  const shown = Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
  return `${currency}${shown}/p`;
}
