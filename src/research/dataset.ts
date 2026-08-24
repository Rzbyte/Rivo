// The research dataset: one row per moment Rivo could have taken a real trade.
//
// This is deliberately NOT src/backtest/replay.ts. That module answers "how
// would the current strategy have done"; this one answers a different question —
// "given what DreamDEX priced, when is that price wrong?" — and the difference
// shows up in three places.
//
// 1. THE PRICE IS THE PRIOR, NOT THE OPPONENT.
//    The old framing computes a fair value independently and reads the whole gap
//    to the market as edge. Thirty days of that returned -30.8% on a model whose
//    directional accuracy was fine. So here the market price is the baseline
//    estimate and the only thing to be predicted is the RESIDUAL,
//    `settled - price`, which for a taker is also exactly the per-share P&L.
//    Target and economics are the same number; there is no gap between "the
//    model was right" and "the trade made money" to be papered over later.
//
// 2. ONLY THE SIDE THAT WAS ACTUALLY TAKEABLE.
//    replay.ts emits both legs of every fill, pricing DOWN at 1 - p on the
//    argument that a complete set can always be assembled. That is a claim about
//    the venue's minting behaviour, and a backtest should not rest on it. A fill
//    proves exactly one direction was available: if the resting order was
//    SELL_YES then a taker could buy UP at p, and if it was BUY_YES then a taker
//    could sell UP at p, which is to say buy DOWN at 1 - p. Rows carry
//    `executable` so the restriction can be tested rather than assumed.
//
// 3. MARKETS ARE THE UNIT, NOT FILLS.
//    Every fill inside one window shares one settlement. Fifty rows from a
//    window that resolved UP are fifty copies of one coin flip, and treating
//    them as fifty observations understates every standard error by ~7x. The
//    cluster key is on every row and everything downstream resamples by it.
//
// Leakage control is stated per feature below. The rule throughout: a feature
// may read a bar only if that bar had CLOSED before `at`, and may read a fill
// only if that fill happened strictly before `at`.

import type { Asset } from "../core/config.js";
import { ASSETS } from "../core/config.js";
import { Indexer, scaleReference, type MarketRow } from "../core/indexer.js";
import { fairValue, clampProbability } from "../model/fairvalue.js";
import { sigmaPerMinute, type Bar } from "../model/vol.js";
import { legDelta } from "../engine/opportunity.js";
import { deltaPer1Pct } from "../portfolio/risk.js";
import type { Leg } from "../engine/book.js";
import { DEFAULT_VOL_LOOKBACK_MIN } from "../calibration/dataset.js";

/**
 * One decision opportunity.
 *
 * Everything above `won` was knowable at `at`. Everything from `won` down is the
 * answer, and exists only for scoring.
 */
export interface Observation {
  // --- identity ------------------------------------------------------------
  at: number;
  /** Cluster key. Outcomes are shared within a window; standard errors must be. */
  marketId: string;
  asset: Asset;
  intervalSec: number;
  /** Settlement time. The walk-forward split orders on THIS, not on `at`. */
  expiry: number;
  leg: Leg;

  // --- the venue's own estimate, and the price Rivo would pay --------------
  /** Executable price for this leg: what a taker hands over per share. */
  price: number;
  /** True when `makerSide` proves a taker could have hit this leg at `price`. */
  executable: boolean;
  /** Shares that actually changed hands. The honest size cap. */
  size: number;

  // --- features, all strictly as of `at` -----------------------------------
  /** The current production model's probability for this leg. */
  fair: number;
  /** fair − price. The signal the production system trades on today. */
  diffusionGap: number;
  /** Minutes to settlement. */
  tauMinutes: number;
  /** log(1 + minutes), because decay in these markets is not linear in time. */
  logTau: number;
  /** Fraction of the window elapsed. */
  phase: number;
  /** How far spot sits above (+) or below (−) the settlement reference, in logs. */
  moneyness: number;
  /** Standardised distance to the strike over the remaining window. */
  z: number;
  sigmaRemaining: number;
  sigmaPerMin: number;
  /** |price − 0.5|: how much of a longshot this leg is. */
  distanceFromHalf: number;
  /** Underlying log returns over the last 1/5/15 CLOSED minutes. */
  ret1m: number;
  ret5m: number;
  ret15m: number;
  /** Short-horizon vol over long-horizon vol. Above 1 is an agitated regime. */
  volRatio: number;
  /** Change in this leg's price since the previous fill in the same window. */
  priceChange: number;
  /** Seconds since the previous fill in this window; 0 when this is the first. */
  secsSincePrevFill: number;
  /** How many fills already happened in this window before this one. */
  fillsBefore: number;
  /** Seconds between the close of the bar priced against and this fill. */
  spotLagSec: number;
  /** Collateral P&L per 1% underlying move, per share. Used by the allocator. */
  deltaPer1PctPerShare: number;
  /** Which side rested. Diagnostic; the executable flag is derived from it. */
  makerSide: string;

  // --- the answer ----------------------------------------------------------
  /** 1 if this leg paid out. */
  won: 0 | 1;
  /**
   * Per-share profit for taking this leg: `won − price`.
   *
   * Also the residual target. That they are the same number is the point of the
   * whole reformulation.
   */
  ret: number;
}

export interface BuildOptions {
  days?: number;
  cadences?: number[];
  volLookbackMin?: number;
  minSize?: number;
  /** Emit the non-executable side too, for measuring what that assumption costs. */
  keepBothLegs?: boolean;
  onProgress?: (m: string) => void;
}

/** Feature names, in the order the design matrix uses them. */
export const FEATURES = [
  "distanceFromHalf",
  "priceCentred",
  "diffusionGap",
  "logTau",
  "phase",
  "moneyness",
  "z",
  "sigmaRemaining",
  "ret1m",
  "ret5m",
  "ret15m",
  "volRatio",
  "priceChange",
  "fillsBeforeLog",
  "isUp",
  "isBtc",
] as const;

/**
 * The design row for a model.
 *
 * `priceCentred` rather than `price` so the intercept means "residual at a
 * coin-flip price" instead of "residual at a free contract", which is outside
 * the data and would make the intercept uninterpretable.
 */
export function featureVector(o: Observation): number[] {
  return [
    o.distanceFromHalf,
    o.price - 0.5,
    o.diffusionGap,
    o.logTau,
    o.phase,
    o.moneyness,
    o.z,
    o.sigmaRemaining,
    o.ret1m,
    o.ret5m,
    o.ret15m,
    o.volRatio,
    o.priceChange,
    Math.log1p(o.fillsBefore),
    o.leg === "UP" ? 1 : 0,
    o.asset === "BTC" ? 1 : 0,
  ];
}

class BarIndex {
  private readonly byMinute = new Map<number, number>();
  constructor(readonly bars: Bar[]) {
    for (let i = 0; i < bars.length; i++) this.byMinute.set(Math.floor(bars[i]!.t / 60), i);
  }
  /**
   * Index of the last bar FULLY CLOSED at `sec`.
   *
   * The bar stamped `t` covers [t, t+60), so it is only usable from t+60. The
   * `- 60` is the whole leakage guard for every price-derived feature.
   */
  at(sec: number): number {
    let m = Math.floor((sec - 60) / 60);
    for (let back = 0; back < 30; back++, m--) {
      const i = this.byMinute.get(m);
      if (i !== undefined) return i;
    }
    return -1;
  }
}

/** Log return over `n` closed bars ending at index `i`. Zero when history is short. */
function logReturn(bars: Bar[], i: number, n: number): number {
  const j = i - n;
  if (j < 0) return 0;
  const a = bars[j]!.close;
  const b = bars[i]!.close;
  if (!(a > 0) || !(b > 0)) return 0;
  return Math.log(b / a);
}

/**
 * Which leg a taker could actually have hit, given which side was resting.
 *
 * `SELL_YES` resting means a taker bought UP at the fill price. `BUY_YES`
 * resting means a taker sold UP, which is buying DOWN at 1 − price. Anything
 * else is unknown and treated as not executable rather than guessed.
 */
export function executableLeg(makerSide: string): Leg | null {
  const s = makerSide.toUpperCase();
  if (s === "SELL_YES") return "UP";
  if (s === "BUY_YES") return "DOWN";
  return null;
}

export async function buildObservations(
  idx: Indexer,
  o: BuildOptions = {},
): Promise<{ rows: Observation[]; markets: number; windows: number }> {
  const log = o.onProgress ?? (() => {});
  const lookback = o.volLookbackMin ?? DEFAULT_VOL_LOOKBACK_MIN;
  const cadences = o.cadences ?? [900, 3600, 14400, 86400];
  const since = Math.floor(Date.now() / 1000) - (o.days ?? 90) * 86_400;

  log("fetching settled markets…");
  const all = await idx.settledMarkets({ sinceExpiry: since });
  const markets = all.filter(
    (m) =>
      !m.voided &&
      (m.winningOutcome === 0 || m.winningOutcome === 1) &&
      ASSETS.includes(m.asset) &&
      cadences.some((c) => Math.abs(m.intervalSec - c) <= Math.max(2, c * 0.01)) &&
      m.tradeCount > 0,
  );
  log(`  ${markets.length} settled windows that traded (of ${all.length} settled)`);
  if (markets.length === 0) return { rows: [], markets: all.length, windows: 0 };

  log("fetching fills…");
  const fills = await idx.fills(markets.map((m) => m.marketId));
  log("resolving opening references…");
  const refs = await idx.openingReferences(markets.map((m) => m.marketId));

  const from = Math.min(...markets.map(startOf));
  const to = Math.max(...markets.map((m) => m.expiry));
  const bars = new Map<Asset, BarIndex>();
  for (const asset of ASSETS) {
    if (!markets.some((m) => m.asset === asset)) continue;
    log(`fetching ${asset} candles…`);
    bars.set(asset, new BarIndex(await idx.candles(asset, from - lookback * 60 - 60, to + 120)));
  }

  const rows: Observation[] = [];
  let windows = 0;

  for (const m of markets) {
    const list = fills.get(m.marketId.toLowerCase());
    if (!list || list.length === 0) continue;
    const index = bars.get(m.asset);
    const raw = refs.get(m.marketId.toLowerCase());
    if (!index || raw === undefined) continue;
    const start = startOf(m);
    const openIdx = index.at(start);
    if (openIdx < 0) continue;
    const reference = scaleReference(raw, index.bars[openIdx]!.close);
    if (reference === null) continue;
    windows++;

    const upWon: 0 | 1 = m.winningOutcome === 0 ? 1 : 0;
    const ordered = [...list].sort((a, b) => a.at - b.at);

    // Previous-fill features read only from fills already iterated, so they can
    // never see the future by construction.
    let prevUpPrice: number | null = null;
    let prevAt: number | null = null;
    let fillsBefore = 0;

    for (const f of ordered) {
      const seenUpPrice = prevUpPrice;
      const seenAt = prevAt;
      const seenCount = fillsBefore;
      prevUpPrice = f.price;
      prevAt = f.at;
      fillsBefore++;

      if (f.size < (o.minSize ?? 0.5)) continue;
      const i = index.at(f.at);
      if (i < 0) continue;
      const spot = index.bars[i]!.close;
      const spotLagSec = Math.max(0, f.at - (index.bars[i]!.t + 60));
      const sigma = sigmaPerMinute(index.bars, i, lookback);
      if (sigma === null) continue;
      const sigmaShort = sigmaPerMinute(index.bars, i, Math.max(5, Math.round(lookback / 4)));
      const tau = (m.expiry - f.at) / 60;
      if (tau <= 0) continue;
      const fv = fairValue({ spot, reference, sigmaPerMin: sigma, tauMinutes: tau });
      if (!fv) continue;

      const takeable = executableLeg(f.makerSide);
      const legs: Leg[] = o.keepBothLegs ? ["UP", "DOWN"] : takeable ? [takeable] : [];

      for (const leg of legs) {
        const price = leg === "UP" ? f.price : 1 - f.price;
        if (!(price > 0) || !(price < 1)) continue;
        const fair = clampProbability(leg === "UP" ? fv.pUp : 1 - fv.pUp);
        const won: 0 | 1 = leg === "UP" ? upWon : ((1 - upWon) as 0 | 1);
        const prevLegPrice = seenUpPrice === null ? null : leg === "UP" ? seenUpPrice : 1 - seenUpPrice;

        rows.push({
          at: f.at,
          marketId: m.marketId,
          asset: m.asset,
          intervalSec: m.intervalSec,
          expiry: m.expiry,
          leg,
          price,
          executable: takeable === leg,
          size: f.size,
          fair,
          diffusionGap: fair - price,
          tauMinutes: tau,
          logTau: Math.log1p(tau),
          phase: Math.min(1, Math.max(0, (f.at - start) / Math.max(1, m.expiry - start))),
          moneyness: fv.moneyness,
          z: fv.z,
          sigmaRemaining: fv.sigmaRemaining,
          sigmaPerMin: sigma,
          distanceFromHalf: Math.abs(price - 0.5),
          ret1m: logReturn(index.bars, i, 1),
          ret5m: logReturn(index.bars, i, 5),
          ret15m: logReturn(index.bars, i, 15),
          volRatio: sigmaShort === null || sigma <= 0 ? 1 : sigmaShort / sigma,
          priceChange: prevLegPrice === null ? 0 : price - prevLegPrice,
          secsSincePrevFill: seenAt === null ? 0 : f.at - seenAt,
          fillsBefore: seenCount,
          spotLagSec,
          deltaPer1PctPerShare: deltaPer1Pct(legDelta(leg, spot, fv.z, fv.sigmaRemaining), spot),
          makerSide: f.makerSide,
          won,
          ret: won - price,
        });
      }
    }
  }

  rows.sort((a, b) => a.at - b.at);
  return { rows, markets: all.length, windows };
}

const startOf = (m: MarketRow): number => (m.tradingStart > 0 ? m.tradingStart : m.expiry - (m.intervalSec || 900));
