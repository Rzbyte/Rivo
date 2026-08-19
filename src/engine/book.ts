// The order book of a binary Event Contract, seen from both legs.
//
// There is only ONE book. Prices on it are Up probabilities, and the Down leg is
// the same book read from the other side. What makes this worth its own module
// is that the two legs do not draw on the same orders:
//
//   buy  UP    crosses resting SELL_YES at p
//   sell UP    crosses resting BUY_YES  at p
//   buy  DOWN  crosses resting BUY_YES  at p   -> you pay 1 - p   (mint-a-pair)
//   sell DOWN  crosses resting SELL_YES at p   -> you receive 1 - p (burn-a-pair)
//
// So the liquidity available to BUY DOWN is the resting BUY_YES depth, not the
// SELL_YES depth. A sizer that reads only one side of the raw book will
// underestimate what it can actually fill on the Down leg — and on this venue
// that is the deeper side (26 BUY_YES vs 10 SELL_YES resting, measured
// 2026-08-19). Getting this wrong is silent: orders just fill smaller than asked.

export type Leg = "UP" | "DOWN";

/** One price level, in the leg's OWN probability terms. */
export interface Level {
  /** Price in (0,1) for this leg. */
  price: number;
  /** Shares available at this level. */
  size: number;
}

/** Resting orders as the indexer reports them, always in Up terms. */
export interface RestingOrder {
  /** `BUY_YES` | `SELL_YES` — the venue's own side naming. */
  side: string;
  /** Up-probability, already scaled out of raw units. */
  price: number;
  size: number;
}

/** What a leg can be bought and sold at, priced in that leg's own terms. */
export interface LegBook {
  /** Ascending: cheapest first. Cross these to BUY this leg. */
  asks: Level[];
  /** Descending: best first. Cross these to SELL this leg. */
  bids: Level[];
}

export interface MarketBook {
  UP: LegBook;
  DOWN: LegBook;
}

/**
 * Split resting orders into the four crossing paths.
 *
 * Levels at the same price are merged so depth reflects total size rather than
 * order count — several bots quoting the same tick is the normal case here.
 */
export function buildBook(orders: RestingOrder[]): MarketBook {
  const sellYes: Level[] = [];
  const buyYes: Level[] = [];
  for (const o of orders) {
    if (!(o.price > 0) || !(o.price < 1) || !(o.size > 0)) continue;
    (o.side === "SELL_YES" ? sellYes : o.side === "BUY_YES" ? buyYes : []).push({
      price: o.price,
      size: o.size,
    });
  }
  const complement = (ls: Level[]): Level[] => ls.map((l) => ({ price: 1 - l.price, size: l.size }));
  return {
    UP: { asks: merge(sellYes, "asc"), bids: merge(buyYes, "desc") },
    DOWN: { asks: merge(complement(buyYes), "asc"), bids: merge(complement(sellYes), "desc") },
  };
}

function merge(levels: Level[], dir: "asc" | "desc"): Level[] {
  const by = new Map<number, number>();
  for (const l of levels) by.set(l.price, (by.get(l.price) ?? 0) + l.size);
  const out = [...by].map(([price, size]) => ({ price, size }));
  out.sort((a, b) => (dir === "asc" ? a.price - b.price : b.price - a.price));
  return out;
}

export interface Fill {
  /** Shares that would fill. */
  size: number;
  /** Average price paid per share. */
  avgPrice: number;
  /** Worst price touched — the level the sweep reached. */
  worstPrice: number;
  /** Total cost in collateral. */
  cost: number;
}

/**
 * Walk the ask side to buy up to `maxShares`, refusing to pay above `limitPrice`.
 *
 * Returns the honest fillable size rather than the requested one. The allocator
 * needs this before it decides, not after: sizing a position the book cannot
 * supply produces a partial fill at a worse average price, which is exactly the
 * outcome the edge calculation assumed away.
 */
export function simulateBuy(book: LegBook, maxShares: number, limitPrice: number): Fill {
  let remaining = maxShares;
  let cost = 0;
  let filled = 0;
  let worst = 0;
  for (const level of book.asks) {
    if (remaining <= 0 || level.price > limitPrice) break;
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    filled += take;
    worst = level.price;
    remaining -= take;
  }
  return { size: filled, avgPrice: filled > 0 ? cost / filled : 0, worstPrice: worst, cost };
}

/** Total size available to buy at or below `limitPrice`. */
export function depthAtOrBetter(book: LegBook, limitPrice: number): number {
  let n = 0;
  for (const level of book.asks) {
    if (level.price > limitPrice) break;
    n += level.size;
  }
  return n;
}

export const bestAsk = (b: LegBook): number | null => b.asks[0]?.price ?? null;
export const bestBid = (b: LegBook): number | null => b.bids[0]?.price ?? null;

/** Mid of a leg, or null when one side is empty. Never invent a mid from one side. */
export function mid(b: LegBook): number | null {
  const a = bestAsk(b);
  const d = bestBid(b);
  return a !== null && d !== null ? (a + d) / 2 : null;
}
