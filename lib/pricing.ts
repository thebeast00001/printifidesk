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
  /** Ids of the desk's extras chosen for this file (0039). Absent means none. */
  extras?: string[];
}

/**
 * A named add-on a desk sells — spiral binding, lamination, A3 — priced
 * per copy of the file or once for the job. The desk's own list, in its
 * own words; the id is what a file's config points at.
 */
export interface Extra {
  id: string;
  name: string;
  price: number;
  per: "copy" | "job";
}

/** The desk's extras from its row (or an order's snapshot), every one checked before it's trusted. */
export function extrasOf(raw: unknown): Extra[] {
  if (!Array.isArray(raw)) return [];
  const out: Extra[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const { id, name, price, per } = e as Record<string, unknown>;
    const n = typeof price === "string" ? Number.parseFloat(price) : price;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) continue;
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 40) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 5000) continue;
    if (per !== "copy" && per !== "job") continue;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, name: name.trim(), price: n, per });
  }
  return out.slice(0, 12);
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
   * Printifi's share, a percentage of the order after the minimum. Not the
   * desk's to set: it comes from platform_settings, is merged onto the
   * operator row when it's fetched, and is snapshotted onto every order.
   */
  platformFeePercent: number;
  /** A floor per order, so a ₹6 job doesn't show a fee of ₹0.18. */
  platformFeeMin: number;
  /**
   * Lift the total to the next whole rupee, shown as its own line. A desk
   * paid into a personal UPI id turns this on: the student types the
   * amount, and ₹14 is typed right far more often than ₹13.91.
   */
  roundToRupee: boolean;
  /** The desk's named add-ons (0039); empty for a desk that sells none. */
  extras: Extra[];
  /**
   * The cover sheet every job comes out under (0044): the desk's price for
   * it, one line on the bill. Zero when the desk has turned the sheet off,
   * and on a snapshot from before it existed.
   */
  coverPrice: number;
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
  round_to_rupee?: boolean | null;
  extras?: unknown;
  cover_sheet?: boolean | null;
  cover_price?: number | string | null;
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
    roundToRupee: operator?.round_to_rupee === true,
    extras: extrasOf(operator?.extras),
    coverPrice: operator?.cover_sheet === false ? 0 : Math.max(0, num(operator?.cover_price, 0)),
  };
}

/**
 * The total a desk is paid: lines, minimum, fee — then, if the desk rounds,
 * up to the next rupee. Returns what rounding added so the bill can show it.
 * The database does the same in place_order() (0028).
 */
export function roundedTotal(unrounded: number, card: RateCard): { total: number; rounding: number } {
  const exact = paise(unrounded);
  if (!card.roundToRupee) return { total: exact, rounding: 0 };
  const total = Math.ceil(exact - 1e-9);
  return { total, rounding: paise(total - exact) };
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
  /** The desk's extras this file chose, all copies. */
  extras: number;
  price: number;
}

export interface Quote {
  bwPages: number;
  colourPages: number;
  paper: number;
  binding: number;
  /** Extras across every file. */
  extras: number;
  /** The cover sheet (0044): one line for the job, inside the subtotal's reach of the minimum. */
  cover: number;
  duplexSaving: number;
  bulkSaving: number;
  /** The files, each with its own arithmetic laid out. */
  lines: LineBill[];
  /** Sum of the line prices, before the minimum. */
  subtotal: number;
  /** What the minimum order added, if it did. */
  topUp: number;
  /** Printifi's share, on top of the lines and the top-up. */
  platformFee: number;
  /** What lifting to the next rupee added; zero unless the desk rounds. */
  rounding: number;
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
  extras: number;
  duplexSaving: number;
  bulkSaving: number;
  raw: number;
}

/**
 * What a file's chosen extras cost: per-copy ones by the copies, per-job
 * ones once. Unknown ids cost nothing — the desk may have dropped one
 * since the file was set up — and place_order() refuses them anyway.
 */
export function extrasCost(config: PrintConfig, card: RateCard, copies: number): number {
  const chosen = config.extras ?? [];
  if (chosen.length === 0) return 0;
  return card.extras
    .filter((e) => chosen.includes(e.id))
    .reduce((n, e) => n + e.price * (e.per === "copy" ? copies : 1), 0);
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
  const extras = extrasCost(config, card, copies);

  return {
    bwPages: bwPages * copies,
    inkedPages: inkedPages * copies,
    bwList: bwPages * card.bwPerPage,
    colourList: inkedPages * card.colourPerPage,
    paper: paper * copies,
    binding: bind * copies,
    extras,
    duplexSaving: duplexSaving * copies,
    bulkSaving: bulkSaving * copies,
    // The same sum, in the same order, as price_line() in the database.
    raw: (paper + bind) * copies + extras,
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
    extras: paise(cost.extras),
  };
  const summed = paise(
    parts.bwCost + parts.colourCost - parts.bulkSaving - parts.duplexSaving + parts.binding + parts.extras,
  );
  const drift = paise(price - summed);
  if (drift !== 0) {
    const key = (["bwCost", "colourCost", "binding", "extras"] as const).reduce((a, b) =>
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
  // The cover sheet (0044) is one more line of the job — under the minimum
  // and the fee like the rest. place_order() adds it in the same place.
  const cover = paise(card.coverPrice);
  const base = Math.max(subtotal + cover, minOrder);
  const topUp = paise(base - subtotal - cover);
  // The minimum lifts the lines; the fee sits on top of that.
  const platformFee = platformFeeOn(base, card);
  const { total, rounding } = roundedTotal(base + platformFee, card);

  // What the same job would have cost printed entirely in colour. Used by the
  // savings widget, so every line counts regardless of what it was set to.
  const fullColourSum = paise(
    lines
      .map((l) => paise(lineCost(l.pages, l.pages, { ...l.config, colour: "full" }, card, bulk).raw))
      .reduce((n, v) => n + v, 0),
  );
  const fullColourBase = Math.max(fullColourSum + cover, minOrder);
  const fullColourTotal = roundedTotal(fullColourBase + platformFeeOn(fullColourBase, card), card).total;

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
  const smartBase = Math.max(smartSum + cover, minOrder);
  const smartTotal = roundedTotal(smartBase + platformFeeOn(smartBase, card), card).total;

  return {
    bwPages: sum((c) => c.bwPages),
    colourPages: sum((c) => c.inkedPages),
    paper: paise(sum((c) => c.paper)),
    binding: paise(sum((c) => c.binding)),
    extras: paise(sum((c) => c.extras)),
    cover,
    duplexSaving: paise(sum((c) => c.duplexSaving)),
    bulkSaving: paise(sum((c) => c.bulkSaving)),
    lines: bills,
    subtotal,
    topUp,
    platformFee,
    rounding,
    total,
    fullColourTotal,
    smartSaving: Math.max(0, paise(smartTotal - total)),
    minApplied: subtotal + cover < minOrder,
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
  if (config.extras?.length) parts.push(config.extras.length === 1 ? "1 extra" : `${config.extras.length} extras`);
  if (config.copies > 1) parts.push(`${config.copies} copies`);
  return parts.join(" + ");
}

/** Two files' extras, compared as sets. */
export function sameExtras(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
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
    key === "extras"
      ? lines.some((l) => !sameExtras(l.config.extras, lines[0].config.extras))
      : lines.some((l) => l.config[key] !== lines[0].config[key]);

  const differing = (["colour", "sides", "binding", "copies", "extras"] as const)
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
