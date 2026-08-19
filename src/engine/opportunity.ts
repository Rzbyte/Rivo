// The Opportunity Engine: price every live window, then say what could be traded
// and at what size the book will actually supply.
//
// It scores LEGS, not markets. A market is one question; the tradeable objects
// are its Up and Down legs, and they have different prices, different depth, and
// different counterparties (see book.ts). Collapsing them to one "direction"
// loses the fact that the cheap side is often the deep side.

import type { Asset } from "../core/config.js";
import { fairValue, clampProbability } from "../model/fairvalue.js";
import { sigmaPerMinute, type Bar } from "../model/vol.js";
import {
  bestAsk,
  bestBid,
  buildBook,
  depthAtOrBetter,
  mid,
  simulateBuy,
  type Leg,
  type MarketBook,
  type RestingOrder,
} from "./book.js";

export interface LiveWindow {
  marketId: string;
  asset: Asset;
  intervalSec: number;
  tradingStart: number;
  expiry: number;
  /** Resolved opening price this window settles against, in real price units. */
  reference: number;
  orders: RestingOrder[];
}

export interface MarketContext {
  spot: number;
  /** Age of the spot reading in seconds — a stale feed must not price anything. */
  spotAgeSec: number;
  bars: Bar[];
  volLookbackMin: number;
}

/** A single tradeable leg, priced and sized. */
export interface Opportunity {
  marketId: string;
  asset: Asset;
  intervalSec: number;
  leg: Leg;
  /** Our probability that THIS leg pays 1. */
  fair: number;
  /** Cheapest price this leg can be bought at right now. */
  ask: number | null;
  /** Mid of this leg, when both sides are quoted. */
  mid: number | null;
  /** fair − ask: expected value per share, in collateral. */
  edge: number | null;
  /** Shares available at or below our fair value. */
  depthAtFair: number;
  /** Unix seconds at which this window settles. */
  expiry: number;
  /** Minutes until settlement. */
  tauMinutes: number;
  /** Fraction of the window elapsed. */
  phase: number;
  /** How far spot sits above (+) or below (−) the settlement reference, in logs. */
  moneyness: number;
  sigmaRemaining: number;
  z: number;
  /**
   * Price sensitivity of this leg to the underlying, per unit of spot.
   * The portfolio risk engine sums these into a per-asset delta.
   */
  deltaPerShare: number;
  /** Why this leg is not actionable, when it is not. */
  blocked: string | null;
}

export interface ScanOptions {
  /** Reject a spot reading older than this. A stalled feed reads as certainty. */
  maxSpotAgeSec?: number;
  /**
   * Stop acting this fraction of the window before expiry. The venue can lock a
   * market between the book snapshot and the send; the kit's `ec-*` strategies
   * scale the same guard to the series cadence rather than using a fixed number,
   * because 300s of headroom rejects every window on a 5-minute series.
   */
  expiryHeadroomFraction?: number;
  headroomFloorSec?: number;
  headroomCapSec?: number;
  /** Minimum edge per share before a leg is worth crossing a spread for. */
  minEdge?: number;
  now?: number;
}

export const DEFAULTS = {
  maxSpotAgeSec: 60,
  expiryHeadroomFraction: 0.4,
  headroomFloorSec: 30,
  headroomCapSec: 300,
  minEdge: 0.02,
} as const;

/** Seconds of headroom required before expiry, scaled to the series cadence. */
export function headroomSec(intervalSec: number, o: ScanOptions = {}): number {
  const frac = o.expiryHeadroomFraction ?? DEFAULTS.expiryHeadroomFraction;
  const floor = o.headroomFloorSec ?? DEFAULTS.headroomFloorSec;
  const cap = o.headroomCapSec ?? DEFAULTS.headroomCapSec;
  return Math.min(cap, Math.max(floor, intervalSec * frac));
}

/**
 * Score both legs of one window.
 *
 * Always returns both legs, including blocked ones. The UI's "why" panel and the
 * shadow log both need to show what was considered and rejected — a scanner that
 * silently drops candidates cannot explain itself.
 */
export function scoreWindow(w: LiveWindow, ctx: MarketContext, o: ScanOptions = {}): Opportunity[] {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const book = buildBook(w.orders);
  const life = Math.max(1, w.expiry - w.tradingStart);
  const secsLeft = w.expiry - now;
  const tauMinutes = secsLeft / 60;
  const phase = Math.min(1, Math.max(0, (now - w.tradingStart) / life));

  const sigma = sigmaPerMinute(ctx.bars, ctx.bars.length - 1, ctx.volLookbackMin);
  const fv =
    sigma === null
      ? null
      : fairValue({ spot: ctx.spot, reference: w.reference, sigmaPerMin: sigma, tauMinutes: Math.max(tauMinutes, 1 / 60) });

  // One blocking reason for the whole window, evaluated before per-leg pricing.
  const windowBlock =
    ctx.spotAgeSec > (o.maxSpotAgeSec ?? DEFAULTS.maxSpotAgeSec)
      ? `spot stale (${Math.round(ctx.spotAgeSec)}s)`
      : sigma === null
        ? "insufficient volatility history"
        : fv === null
          ? "fair value undefined"
          : secsLeft <= headroomSec(w.intervalSec, o)
            ? `inside expiry headroom (${Math.round(secsLeft)}s left)`
            : null;

  return (["UP", "DOWN"] as const).map((leg) => {
    const lb = book[leg];
    const ask = bestAsk(lb);
    const fair = fv === null ? NaN : clampProbability(leg === "UP" ? fv.pUp : 1 - fv.pUp);
    const edge = fv === null || ask === null ? null : fair - ask;
    return {
      marketId: w.marketId,
      asset: w.asset,
      intervalSec: w.intervalSec,
      expiry: w.expiry,
      leg,
      fair,
      ask,
      mid: mid(lb),
      edge,
      depthAtFair: fv === null ? 0 : depthAtOrBetter(lb, fair),
      tauMinutes,
      phase,
      moneyness: fv?.moneyness ?? NaN,
      sigmaRemaining: fv?.sigmaRemaining ?? NaN,
      z: fv?.z ?? NaN,
      deltaPerShare: fv === null ? 0 : legDelta(leg, ctx.spot, fv.z, fv.sigmaRemaining),
      blocked:
        windowBlock ??
        (ask === null
          ? "no offer on this leg"
          : edge !== null && edge < (o.minEdge ?? DEFAULTS.minEdge)
            ? `edge ${edge >= 0 ? "+" : ""}${edge.toFixed(3)} below floor`
            : null),
    } satisfies Opportunity;
  });
}

/**
 * How much one share of a leg moves per unit move in the underlying.
 *
 * d/dS of Phi(ln(S/R) / sigma_rem) = phi(z) / (S * sigma_rem), and the Down leg
 * is its exact negative since the two legs sum to one. This is what makes
 * exposure additive across markets: a BTC-15m Up position and a BTC-4h Up
 * position are the same bet in different sizes, and only a delta says so.
 */
export function legDelta(leg: Leg, spot: number, z: number, sigmaRemaining: number): number {
  if (!(spot > 0) || !(sigmaRemaining > 0)) return 0;
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const d = pdf / (spot * sigmaRemaining);
  return leg === "UP" ? d : -d;
}

/** What a given budget can actually buy on this leg, at or below fair value. */
export function fillableFor(
  opp: Opportunity,
  book: MarketBook,
  budgetCollateral: number,
): { shares: number; avgPrice: number; cost: number } {
  const lb = book[opp.leg];
  const ask = bestAsk(lb);
  if (ask === null || !(budgetCollateral > 0) || !Number.isFinite(opp.fair)) {
    return { shares: 0, avgPrice: 0, cost: 0 };
  }
  // Never pay above fair — an "edge" that requires paying more than the contract
  // is worth is not an edge, and sweeping deeper levels is how a sizer quietly
  // converts a positive-expectancy trade into a negative one.
  const maxShares = budgetCollateral / ask;
  const fill = simulateBuy(lb, maxShares, opp.fair);
  if (fill.cost <= budgetCollateral) return { shares: fill.size, avgPrice: fill.avgPrice, cost: fill.cost };
  const scaled = simulateBuy(lb, (maxShares * budgetCollateral) / Math.max(fill.cost, 1e-12), opp.fair);
  return { shares: scaled.size, avgPrice: scaled.avgPrice, cost: scaled.cost };
}

export { bestBid };
