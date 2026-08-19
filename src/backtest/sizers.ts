// The competing position-sizing rules.
//
// All of them see the same opportunity stream, so the only difference in the
// result is the rule itself. The pair that matters is `rivo` against
// `kellyUnconstrained`: identical forecasts, identical Kelly arithmetic, and the
// only difference is whether the portfolio constraints are allowed to speak. If
// the constrained version does not earn its keep there, the portfolio layer is
// decoration and should be cut.

import { kellyFraction } from "../portfolio/allocator.js";
import { expiryBucket, riskOf, type Position } from "../portfolio/risk.js";
import type { Chance, Sizer, SimState, Trade } from "./replay.js";

const asPositions = (open: Trade[]): Position[] =>
  open.map((t) => ({
    marketId: t.marketId,
    asset: t.asset,
    intervalSec: 0,
    leg: t.leg,
    shares: t.shares,
    entryPrice: t.price,
    cost: t.cost,
    expiry: t.expiry,
    deltaPer1PctPerShare: t.deltaPer1PctPerShare,
  }));

/** Rivo: fractional Kelly, then every portfolio constraint in turn. */
export const rivo: Sizer = {
  name: "Rivo (Kelly + portfolio constraints)",
  size(c: Chance, s: SimState): number {
    const p = s.profile;
    if (c.edge < p.minEdge) return 0;

    const k = kellyFraction(c.fair, c.price);
    if (!(k > 0)) return 0;
    // Kelly and the position cap both name a target for the WHOLE leg, so what
    // is already held counts against them. Sizing incrementally would let a leg
    // accumulate past its own cap one order at a time — the same bug the live
    // allocator had, and the backtest has to model the fixed behaviour or it
    // stops being evidence about the thing that ships.
    const heldInLeg = s.open
      .filter((t) => t.marketId === c.marketId && t.leg === c.leg)
      .reduce((n, t) => n + t.cost, 0);

    let stake = Math.max(0, k * p.kellyFraction * s.equity - heldInLeg);
    stake = Math.min(stake, Math.max(0, s.equity * p.maxPerPosition - heldInLeg));

    const risk = riskOf(asPositions(s.open), s.rho);
    stake = Math.min(stake, Math.max(0, s.equity * p.maxDeployed - risk.capitalAtRisk));
    stake = Math.min(stake, Math.max(0, s.equity * (1 - p.cashFloor) - risk.capitalAtRisk));

    // Directional budgets. Signed headroom, so a leg that offsets existing
    // exposure gets room and one that piles on does not.
    const per = c.deltaPer1PctPerShare;
    if (Math.abs(per) > 1e-12) {
      const assetBudget = s.equity * p.maxAssetDeltaPer1Pct;
      const existing = risk.assetDelta.get(c.asset) ?? 0;
      stake = Math.min(stake, headroomShares(existing, per, assetBudget) * c.price);

      const combinedPer = c.asset === "BTC" ? per : s.rho * per;
      const combBudget = s.equity * p.maxCombinedDeltaPer1Pct;
      stake = Math.min(stake, headroomShares(risk.combinedDelta, combinedPer, combBudget) * c.price);
    }

    const bucket = expiryBucket(c.expiry);
    const inBucket = risk.expiryBuckets.get(bucket) ?? 0;
    stake = Math.min(stake, Math.max(0, s.equity * p.maxPerExpiryBucket - inBucket));

    return Math.max(0, stake);
  },
};

/**
 * The same forecasts and the same Kelly haircut, with no portfolio view at all.
 *
 * This is the honest opponent. It is not a strawman — it is what a well-built
 * single-market bot does, and on a venue where the top candidates are routinely
 * the same bet at different tenors it is exactly the mistake worth measuring.
 */
export const kellyUnconstrained: Sizer = {
  name: "Kelly, no portfolio constraints",
  size(c: Chance, s: SimState): number {
    if (c.edge < s.profile.minEdge) return 0;
    const k = kellyFraction(c.fair, c.price);
    if (!(k > 0)) return 0;
    return Math.max(0, k * s.profile.kellyFraction * s.equity);
  },
};

/** Full Kelly, no constraints — the growth-optimal rule taken literally. */
export const kellyFull: Sizer = {
  name: "Full Kelly, no constraints",
  size(c: Chance, s: SimState): number {
    if (c.edge < s.profile.minEdge) return 0;
    return Math.max(0, kellyFraction(c.fair, c.price) * s.equity);
  },
};

/** Fixed fraction of equity on every positive-edge chance. */
export const equalWeight = (fraction = 0.05): Sizer => ({
  name: `Equal weight (${(fraction * 100).toFixed(0)}% each)`,
  size(c: Chance, s: SimState): number {
    return c.edge < s.profile.minEdge ? 0 : s.equity * fraction;
  },
});

/** Everything available, every time there is an edge. */
export const allIn: Sizer = {
  name: "All-in on any edge",
  size(c: Chance, s: SimState): number {
    return c.edge < s.profile.minEdge ? 0 : s.cash;
  },
};

/** Take everything, ignore the edge floor entirely. */
export const anyEdge = (fraction = 0.05): Sizer => ({
  name: `Any positive edge (${(fraction * 100).toFixed(0)}% each)`,
  size(_c: Chance, s: SimState): number {
    return s.equity * fraction;
  },
});

/** Shares of `perShare` delta that fit before |exposure| passes `limit`. */
function headroomShares(existing: number, perShare: number, limit: number): number {
  if (Math.abs(perShare) < 1e-12) return Number.POSITIVE_INFINITY;
  const target = perShare > 0 ? limit : -limit;
  return Math.max(0, (target - existing) / perShare);
}
