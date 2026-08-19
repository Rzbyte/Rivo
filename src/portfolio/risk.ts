// Portfolio risk, in three numbers.
//
// The temptation on a venue with eight live windows is to build a covariance
// matrix. Resist it: the correlation here is structural and known before any
// data arrives. Every window asks the same question about the same two assets at
// a different horizon, so exposure is a factor problem, not an estimation one.
//
//   1. per-asset delta          — BTC-15m UP and BTC-4h UP are ONE bet
//   2. combined delta           — BTC and ETH move together; measure rho, don't assume it
//   3. per-expiry-bucket capital — windows settling together fail together
//
// Max loss on a long binary is exactly the premium paid, so capital-at-risk needs
// no VaR: it is the sum of what was spent.

import type { Asset } from "../core/config.js";
import type { Bar } from "../model/vol.js";
import type { Leg } from "../engine/book.js";

/** An open (or proposed) position in one leg of one window. */
export interface Position {
  marketId: string;
  asset: Asset;
  intervalSec: number;
  leg: Leg;
  shares: number;
  /** Average price paid per share. */
  entryPrice: number;
  /** Collateral spent — and, for a long binary, the exact maximum loss. */
  cost: number;
  /** Unix seconds at which this window settles. */
  expiry: number;
  /**
   * Collateral gained/lost per 1% rise in the underlying, for ONE share.
   * Signed: positive on Up legs, negative on Down legs.
   */
  deltaPer1PctPerShare: number;
}

/**
 * Convert the raw price-sensitivity of a leg into collateral per 1% move.
 *
 * `deltaPerShare` is dP/dS — probability per dollar of spot — which is not
 * comparable across assets: a unit move in BTC at 68,000 is nothing like a unit
 * move in ETH at 2,100. Scaling by spot and by 1% puts both on one axis that also
 * happens to be the one a person can read: "if BTC moves 1%, this costs me $X".
 */
export const deltaPer1Pct = (deltaPerShare: number, spot: number): number => deltaPerShare * spot * 0.01;

export interface RiskState {
  /** Signed collateral-per-1% exposure, by underlying. */
  assetDelta: Map<Asset, number>;
  /** Signed exposure with BTC and ETH combined through their measured correlation. */
  combinedDelta: number;
  /** Capital committed, by expiry bucket key. */
  expiryBuckets: Map<string, number>;
  /** Total collateral spent and still at risk. */
  capitalAtRisk: number;
  /** Worst case if every position resolves against us — for binaries, the premium. */
  maxLoss: number;
}

/**
 * Group settlements that land close enough together to fail together.
 *
 * The venue rolls 15m windows on the quarter hour and longer ones on top of them,
 * so several positions routinely settle in the same instant. Bucketing by a
 * 15-minute grid captures that without pretending to more precision than the
 * schedule has.
 */
export const EXPIRY_BUCKET_SEC = 900;
export const expiryBucket = (expiry: number): string =>
  new Date(Math.floor(expiry / EXPIRY_BUCKET_SEC) * EXPIRY_BUCKET_SEC * 1000).toISOString().slice(0, 16);

export function riskOf(positions: Position[], rho: number): RiskState {
  const assetDelta = new Map<Asset, number>();
  const expiryBuckets = new Map<string, number>();
  let capitalAtRisk = 0;

  for (const p of positions) {
    const d = p.shares * p.deltaPer1PctPerShare;
    assetDelta.set(p.asset, (assetDelta.get(p.asset) ?? 0) + d);
    const b = expiryBucket(p.expiry);
    expiryBuckets.set(b, (expiryBuckets.get(b) ?? 0) + p.cost);
    capitalAtRisk += p.cost;
  }

  // BTC and ETH move together, so same-direction exposure in both is more than
  // the sum of its parts under a shared shock. Adding them through rho gives the
  // one-factor stress: what a correlated 1% move in crypto costs the book.
  const btc = assetDelta.get("BTC") ?? 0;
  const eth = assetDelta.get("ETH") ?? 0;
  const combinedDelta = btc + rho * eth;

  return { assetDelta, combinedDelta, expiryBuckets, capitalAtRisk, maxLoss: capitalAtRisk };
}

/**
 * Correlation of BTC and ETH minute returns over the shared window.
 *
 * Measured, never assumed. The number is stable enough to look like a constant
 * and wrong often enough to matter when it is not — a regime where the two
 * decouple is exactly when a portfolio sized on an assumed 0.8 is over-exposed.
 */
export function measureCorrelation(btc: Bar[], eth: Bar[]): number {
  const byMinute = new Map<number, number>();
  for (let i = 1; i < btc.length; i++) {
    const a = btc[i - 1]!;
    const b = btc[i]!;
    if (a.close > 0 && b.close > 0) byMinute.set(Math.floor(b.t / 60), Math.log(b.close / a.close));
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 1; i < eth.length; i++) {
    const a = eth[i - 1]!;
    const b = eth[i]!;
    if (!(a.close > 0) || !(b.close > 0)) continue;
    const x = byMinute.get(Math.floor(b.t / 60));
    if (x === undefined) continue;
    xs.push(x);
    ys.push(Math.log(b.close / a.close));
  }
  if (xs.length < 30) return 0.8; // documented fallback, only when there is no overlap to measure
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const den = Math.sqrt(sxx * syy);
  return den > 0 ? Math.max(-1, Math.min(1, sxy / den)) : 0.8;
}
