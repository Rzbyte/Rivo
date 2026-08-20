// Cross-tenor coherence: does DreamDEX's term structure ever price itself
// inconsistently, and can that be traded without taking a directional view?
//
// ---------------------------------------------------------------------------
// THE DERIVATION, BEFORE ANY CODE
// ---------------------------------------------------------------------------
//
// Window i settles 1 if S(T_i) >= R_i, where R_i is that window's OWN resolved
// opening price. Different tenors therefore compare against different levels,
// which kills the intuitive relation people reach for first:
//
//   P(1h UP) >= P(15m UP)          <-- NOT VALID. Different events entirely.
//
// There is no containment between "closes above its 1h-ago opening" and "closes
// above its 15m-ago opening": neither implies the other, and the references move
// independently. Any monotonicity assumed across tenors is unfounded.
//
// What IS valid needs two windows on the SAME asset sharing the SAME expiry
// instant, with references R_lo < R_hi. Then {S(T) >= R_hi} is a subset of
// {S(T) >= R_lo}, so
//
//   p_lo >= p_hi                                                      (BOUND)
//
// and this is model-free — no volatility assumption, no drift assumption, no
// distributional assumption. It is set inclusion.
//
// Expressed as a trade it is direction-neutral by construction. Buy lo-UP and
// hi-DOWN:
//
//   S(T) >= R_hi        -> lo-UP pays 1, hi-DOWN pays 0   = 1
//   R_lo <= S(T) < R_hi -> both pay                        = 2
//   S(T) <  R_lo        -> lo-UP pays 0, hi-DOWN pays 1   = 1
//
// The minimum payoff is 1 in every state, so the package must cost at least 1.
// Its cost is ask(lo-UP) + ask(hi-DOWN) = p_lo + (1 - p_hi) = 1 + (p_lo - p_hi),
// which is below 1 exactly when the BOUND is violated. The two statements are
// the same statement.
//
// Two things this deliberately does NOT claim:
//
//   * Intra-market arbitrage. Up and Down trade on ONE book where a Down price
//     is 1 minus an Up price, so ask(UP) + ask(DOWN) = 1 + (ask - bid) >= 1
//     always. The structure forbids it; there is nothing to look for.
//   * That a model disagreement is arbitrage. A book that contradicts our fair
//     value is a MODEL-CONSISTENCY violation, and trading it is a directional
//     bet — the same bet the taker backtest already measured as unprofitable at
//     every threshold. Only the BOUND above is direction-neutral, so only the
//     BOUND is tested here.

import { Indexer, type FillRow, type MarketRow } from "../core/indexer.js";

/** Two same-asset windows sharing an expiry instant, ordered by reference. */
export interface CoherencePair {
  asset: string;
  expiry: number;
  /** The window whose reference is LOWER — its Up leg must be worth more. */
  lo: MarketRow;
  hi: MarketRow;
  refLo: number;
  refHi: number;
}

/** One moment where both legs of a pair were observed transacting. */
export interface Observation {
  pair: CoherencePair;
  at: number;
  /** Seconds between the two fills used. */
  skewSec: number;
  pLo: number;
  pHi: number;
  /** Cost of the package minus its guaranteed payoff. Negative = arbitrage. */
  gap: number;
  /** Size that actually changed hands on the thinner leg. */
  size: number;
}

export interface CoherenceReport {
  windowsScanned: number;
  pairsStructural: number;
  pairsBothTraded: number;
  pairsWithReferences: number;
  tenorCombos: { combo: string; n: number }[];
  observations: number;
  violations: number;
  violationRate: number;
  /** Violations that clear the venue's measured round-trip cost. */
  executableViolations: number;
  /**
   * Gross profit if EVERY executable violation had been taken in full, at the
   * size that actually changed hands on the thinner leg.
   *
   * This is a ceiling, and a generous one: it assumes we could have been the
   * taker on both legs of trades we merely observed, and that taking them would
   * not have moved the prices we are measuring.
   */
  grossProfitCeiling: number;
  medianSizeShares: number;
  perOccurrence: number;
  worst: Observation[];
  roundTripCost: number;
  skewToleranceSec: number;
}

/**
 * The kit measures a round trip at about 0.024 on a two-cent book. A violation
 * smaller than that is not an opportunity — it is a number that disappears on
 * contact with the spread.
 */
export const ROUND_TRIP_COST = 0.024;

/** Cadences the venue actually lists; the rest are retired test series. */
const TRADEABLE = new Set([900, 3600, 14400, 86400]);

export interface RunOptions {
  days?: number;
  /** Two fills count as simultaneous within this many seconds. */
  skewSec?: number;
  onProgress?: (m: string) => void;
}

export async function runCoherence(idx: Indexer, o: RunOptions = {}): Promise<CoherenceReport> {
  const log = o.onProgress ?? (() => {});
  const skew = o.skewSec ?? 300;
  const since = Math.floor(Date.now() / 1000) - (o.days ?? 30) * 86_400;

  log("fetching settled windows…");
  const all = await idx.settledMarkets({ sinceExpiry: since });
  const windows = all.filter(
    (m) => TRADEABLE.has(m.intervalSec) && (m.winningOutcome === 0 || m.winningOutcome === 1) && !m.voided,
  );
  log(`  ${windows.length} on listed cadences (of ${all.length})`);

  // Group by the thing that makes the bound valid: same asset, same instant.
  const byExpiry = new Map<string, MarketRow[]>();
  for (const m of windows) {
    const k = `${m.asset}:${m.expiry}`;
    byExpiry.set(k, [...(byExpiry.get(k) ?? []), m]);
  }

  const structural: [MarketRow, MarketRow][] = [];
  const combos = new Map<string, number>();
  for (const group of byExpiry.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        structural.push([a, b]);
        const [x, y] = a.intervalSec <= b.intervalSec ? [a, b] : [b, a];
        const key = `${x.intervalSec}s+${y.intervalSec}s`;
        combos.set(key, (combos.get(key) ?? 0) + 1);
      }
    }
  }
  log(`  ${structural.length} same-asset same-expiry pairs`);

  // Only pairs where BOTH legs traded can ever be executed. This filter is
  // where most of the opportunity dies, and that is itself the finding.
  const traded = structural.filter(([a, b]) => a.tradeCount > 0 && b.tradeCount > 0);
  log(`  ${traded.length} pairs where both legs actually traded`);

  const ids = [...new Set(traded.flatMap(([a, b]) => [a.marketId, b.marketId]))];
  if (ids.length === 0) {
    return empty(windows.length, structural.length, 0, combos, skew);
  }

  log("resolving opening references…");
  const refsRaw = await idx.openingReferences(ids);

  const pairs: CoherencePair[] = [];
  for (const [a, b] of traded) {
    const ra = refsRaw.get(a.marketId.toLowerCase());
    const rb = refsRaw.get(b.marketId.toLowerCase());
    // Equal references would make the two windows the same question, and the
    // bound degenerates to p >= p. Nothing to test.
    if (ra === undefined || rb === undefined || ra === rb) continue;
    const loFirst = ra < rb;
    pairs.push({
      asset: a.asset,
      expiry: a.expiry,
      lo: loFirst ? a : b,
      hi: loFirst ? b : a,
      refLo: Math.min(ra, rb),
      refHi: Math.max(ra, rb),
    });
  }
  log(`  ${pairs.length} pairs with distinct resolved references`);

  log("fetching fills…");
  const fills = await idx.fills(ids);

  // A printed fill proves a counterparty existed at that price for that size —
  // the most honest executable price available without a historical book. It is
  // still optimistic: it shows the trade happened, not that we could have been
  // the one taking it.
  const observations: Observation[] = [];
  for (const pair of pairs) {
    const fl = fills.get(pair.lo.marketId.toLowerCase()) ?? [];
    const fh = fills.get(pair.hi.marketId.toLowerCase()) ?? [];
    if (fl.length === 0 || fh.length === 0) continue;
    for (const a of fl) {
      for (const b of nearby(fh, a.at, skew)) {
        observations.push({
          pair,
          at: Math.min(a.at, b.at),
          skewSec: Math.abs(a.at - b.at),
          pLo: a.price,
          pHi: b.price,
          // cost of the package, minus its guaranteed payoff of 1
          gap: a.price - b.price,
          size: Math.min(a.size, b.size),
        });
      }
    }
  }

  const violations = observations.filter((x) => x.gap < 0);
  const executable = violations.filter((x) => -x.gap > ROUND_TRIP_COST);

  // Net of the round trip, times the size that actually traded.
  const gross = executable.reduce((n, x) => n + (-x.gap - ROUND_TRIP_COST) * x.size, 0);
  const sizes = executable.map((x) => x.size).sort((a, b) => a - b);
  const medianSize = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)]! : 0;

  return {
    grossProfitCeiling: gross,
    medianSizeShares: medianSize,
    perOccurrence: executable.length > 0 ? gross / executable.length : 0,
    windowsScanned: windows.length,
    pairsStructural: structural.length,
    pairsBothTraded: traded.length,
    pairsWithReferences: pairs.length,
    tenorCombos: [...combos].map(([combo, n]) => ({ combo, n })).sort((a, b) => b.n - a.n),
    observations: observations.length,
    violations: violations.length,
    violationRate: observations.length > 0 ? violations.length / observations.length : NaN,
    executableViolations: executable.length,
    worst: [...violations].sort((a, b) => a.gap - b.gap).slice(0, 10),
    roundTripCost: ROUND_TRIP_COST,
    skewToleranceSec: skew,
  };
}

/** Fills within `skew` seconds of `t`. Linear scan is fine at this scale. */
function nearby(rows: FillRow[], t: number, skew: number): FillRow[] {
  return rows.filter((r) => Math.abs(r.at - t) <= skew);
}

function empty(
  windowsScanned: number,
  pairsStructural: number,
  pairsBothTraded: number,
  combos: Map<string, number>,
  skew: number,
): CoherenceReport {
  return {
    windowsScanned,
    pairsStructural,
    pairsBothTraded,
    pairsWithReferences: 0,
    tenorCombos: [...combos].map(([combo, n]) => ({ combo, n })).sort((a, b) => b.n - a.n),
    observations: 0,
    violations: 0,
    violationRate: NaN,
    executableViolations: 0,
    grossProfitCeiling: 0,
    medianSizeShares: 0,
    perOccurrence: 0,
    worst: [],
    roundTripCost: ROUND_TRIP_COST,
    skewToleranceSec: skew,
  };
}
