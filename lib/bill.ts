import type { OrderRow } from "./orders";
import {
  DEFAULT_CONFIG,
  paise,
  quoteOrder,
  rateCardOf,
  type PrintConfig,
  type Quote,
  type RateCard,
  type RateSource,
} from "./pricing";

/**
 * The bill for an order that has already been placed.
 *
 * Rebuilt from the order's own snapshot of the rate card and its items — the
 * same inputs `place_order()` had — so it is the bill the student was
 * actually charged, not a recomputation at whatever the desk charges today.
 *
 * `exact` is whether that reconstruction lands on the stored total to the
 * paisa. It does for anything placed since 0017. For older orders there is
 * no snapshot: the live rates are used and the result is labelled an
 * estimate, and the stored total stays the number that counts.
 */
export function billFor(
  order: OrderRow,
  fallback: RateSource | null,
): { quote: Quote; card: RateCard; names: string[]; exact: boolean; snapshot: boolean } | null {
  const snapshot = order.rate_card ?? null;
  const source = snapshot ?? fallback;
  if (!source) return null;

  const card = rateCardOf(source);
  const items = [...(order.order_items ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

  const lines =
    items.length > 0
      ? items.map((i) => ({
          pages: i.pages,
          colourPages: i.colour_pages,
          config: { ...DEFAULT_CONFIG, ...order.config, ...i.config } as PrintConfig,
        }))
      : [{ pages: order.pages, colourPages: order.colour_pages, config: { ...DEFAULT_CONFIG, ...order.config } }];

  const quote = quoteOrder(lines, card);
  const names = items.length > 0 ? items.map((i) => i.name) : [`${order.pages} pages`];

  return {
    quote,
    card,
    names,
    exact: paise(quote.total) === paise(Number(order.total)),
    snapshot: snapshot !== null,
  };
}
