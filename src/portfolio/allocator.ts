// The Capital Allocator.
//
// Answers one question: given total capital, everything currently live, and what
// is already held — what portfolio should exist right now?
//
// The sizing rule is Kelly, because a binary contract is the case Kelly was
// derived for. Buy a contract at price c that pays 1 with probability p and the
// growth-optimal stake is
//
//     f* = (p - c) / (1 - c)
//
// Two things then stand between that number and an order, and both matter more
// than the formula:
//
//   1. A fraction of it. Kelly assumes p is exactly right; ours is a model. The
//      calibration study says the model needs no shrinking out of sample, so the
//      profile's kellyFraction is the ONLY haircut and is deliberately well under 1.
//
//   2. Constraints that see the whole book. Kelly sizes one bet in isolation, and
//      on this venue the top candidates are routinely the same bet at different
//      tenors — BTC-1h DOWN and BTC-4h DOWN are one directional view expressed
//      twice. Sizing them independently doubles a risk the formula thinks it
//      already accounted for. That is what the delta budget below prevents, and
//      it is the whole reason this layer exists.

import { tenorLabel, type Asset } from "../core/config.js";
import type { MarketBook } from "../engine/book.js";
import { fillableFor, type Opportunity } from "../engine/opportunity.js";
import type { RiskProfile } from "./profiles.js";
import { deltaPer1Pct, expiryBucket, riskOf, type Position, type RiskState } from "./risk.js";

export interface AllocatorInputs {
  totalCapital: number;
  /** Collateral not currently committed. */
  freeCash: number;
  opportunities: Opportunity[];
  books: Map<string, MarketBook>;
  /** Spot per asset — needed to put deltas on a common axis. */
  spot: Map<Asset, number>;
  /** Positions already open. */
  held: Position[];
  /** Measured BTC/ETH return correlation. */
  rho: number;
  profile: RiskProfile;
}

/** What the allocator decided about one leg, and why. */
export interface Decision {
  opportunity: Opportunity;
  action: "BUY" | "SKIP";
  /** Shares to buy. */
  shares: number;
  /** Collateral this costs. */
  cost: number;
  avgPrice: number;
  /** Full Kelly fraction before the profile's haircut. */
  kellyFull: number;
  /** Notional Kelly asked for, after the haircut. */
  kellyTarget: number;
  /** The constraint that determined the final size — the "why". */
  binding: string;
  /** Everything that limited this leg, in the order it was applied. */
  limits: { name: string; allowedCost: number }[];
  /**
   * Correlated exposure to this leg's underlying, before and after, against its
   * budget — in collateral per 1% move.
   *
   * The number that makes a refusal legible. Three BTC windows can each carry
   * positive edge and still be one view held three times; this is what says so.
   * Absent for legs rejected before the delta budget was reached.
   */
  exposure?: { before: number; after: number; cap: number };
}

export interface Allocation {
  decisions: Decision[];
  /** Positions that would exist after acting. */
  projected: Position[];
  riskBefore: RiskState;
  riskAfter: RiskState;
  deployed: number;
  cash: number;
}

/** Smallest trade worth paying a spread for: an absolute floor and a share of capital. */
const MIN_TRADE_ABS = 0.25;
const MIN_TRADE_FRACTION = 0.01;

/** Growth-optimal stake in a binary paying 1 with probability `p`, bought at `c`. */
export function kellyFraction(p: number, c: number): number {
  if (!(c > 0) || !(c < 1)) return 0;
  return (p - c) / (1 - c);
}

export function allocate(input: AllocatorInputs): Allocation {
  const { totalCapital, profile: prof, rho } = input;
  const riskBefore = riskOf(input.held, rho);

  // What is already held, per leg. The allocator answers "what portfolio should
  // exist right now?", so every cap below is a TARGET for the whole leg, not an
  // allowance for one more order. Sizing incrementally looks identical on cycle
  // one and drifts badly by cycle fifty: a 20% per-position limit applied per
  // ORDER lets fifty cycles accumulate many times that in one leg, in fragments,
  // each of which paid a spread to open.
  const heldByLeg = new Map<string, number>();
  for (const p of input.held) {
    const k = `${p.marketId}:${p.leg}`;
    heldByLeg.set(k, (heldByLeg.get(k) ?? 0) + p.cost);
  }

  // Budgets are absolute collateral so every constraint is comparable and the
  // "why" line can quote a number a person can check against the UI.
  const budget = {
    deploy: totalCapital * prof.maxDeployed,
    position: totalCapital * prof.maxPerPosition,
    assetDelta: totalCapital * prof.maxAssetDeltaPer1Pct,
    combinedDelta: totalCapital * prof.maxCombinedDeltaPer1Pct,
    expiryBucket: totalCapital * prof.maxPerExpiryBucket,
    spendable: Math.min(input.freeCash, Math.max(0, totalCapital * (1 - prof.cashFloor) - riskBefore.capitalAtRisk)),
  };

  const positions: Position[] = [...input.held];
  let spent = 0;
  const decisions: Decision[] = [];

  // Best risk-adjusted edge first. Ranking by raw edge would spend the delta
  // budget on whichever leg happens to be cheapest rather than on the one that
  // pays most per unit of the exposure it consumes.
  const ranked = [...input.opportunities]
    .filter((o) => o.blocked === null && o.edge !== null && o.edge > 0)
    .sort((a, b) => score(b) - score(a));

  for (const opp of ranked) {
    const spot = input.spot.get(opp.asset) ?? 0;
    const book = input.books.get(opp.marketId);
    const ask = opp.ask;
    const limits: { name: string; allowedCost: number }[] = [];

    if (!book || ask === null || !(spot > 0)) {
      decisions.push(skip(opp, "no book or spot", limits));
      continue;
    }
    if (opp.edge === null || opp.edge < prof.minEdge) {
      decisions.push(skip(opp, `edge below ${prof.name} floor of ${prof.minEdge}`, limits));
      continue;
    }

    const kFull = kellyFraction(opp.fair, ask);
    // Kelly names the size the WHOLE leg should be, so what is already held
    // counts against it. Otherwise every cycle re-asks for a full Kelly stake in
    // a leg Kelly already considers correctly sized.
    const kellyTarget = Math.max(0, kFull) * prof.kellyFraction * totalCapital;
    const kellyRoom = Math.max(0, kellyTarget - (heldByLeg.get(`${opp.marketId}:${opp.leg}`) ?? 0));
    limits.push({ name: `kelly ${(kFull * prof.kellyFraction * 100).toFixed(1)}% of capital`, allowedCost: kellyRoom });

    const alreadyHeld = heldByLeg.get(`${opp.marketId}:${opp.leg}`) ?? 0;
    limits.push({
      name: `max position ${(prof.maxPerPosition * 100).toFixed(0)}%${alreadyHeld > 0 ? ` (${alreadyHeld.toFixed(2)} already held)` : ""}`,
      allowedCost: Math.max(0, budget.position - alreadyHeld),
    });
    limits.push({ name: `deployed cap ${(prof.maxDeployed * 100).toFixed(0)}%`, allowedCost: Math.max(0, budget.deploy - riskBefore.capitalAtRisk - spent) });
    limits.push({ name: "free cash / cash floor", allowedCost: Math.max(0, budget.spendable - spent) });

    // --- the constraints that see the whole portfolio -----------------------
    const current = riskOf(positions, rho);
    const dPerShare = deltaPer1Pct(opp.deltaPerShare, spot);
    const costPerShare = ask;

    // Captured before anything is decided, so a refusal can report the exposure
    // that refused it. `positions` accumulates within this pass, so this is the
    // exposure INCLUDING everything already taken this cycle — which is the
    // figure that actually bound, not the one the cycle started with.
    const exposureBefore = current.assetDelta.get(opp.asset) ?? 0;
    const exposureContext = { before: exposureBefore, after: exposureBefore, cap: budget.assetDelta };

    if (Math.abs(dPerShare) > 1e-12) {
      // How many shares before this asset's delta budget is exhausted, in the
      // direction this leg pushes. Signed, so a leg that OFFSETS existing
      // exposure is allowed more room than one that adds to it — which is how
      // the same trade can be capped in one portfolio and welcome in another.
      const existing = current.assetDelta.get(opp.asset) ?? 0;
      const room = headroom(existing, dPerShare, budget.assetDelta);
      limits.push({ name: `${opp.asset} delta budget ±${budget.assetDelta.toFixed(2)}/1%`, allowedCost: room * costPerShare });

      const combinedPerShare = opp.asset === "BTC" ? dPerShare : rho * dPerShare;
      const combRoom = headroom(current.combinedDelta, combinedPerShare, budget.combinedDelta);
      limits.push({ name: `combined delta budget (rho ${rho.toFixed(2)})`, allowedCost: combRoom * costPerShare });
    }

    const bucket = expiryBucket(opp.expiry);
    const inBucket = current.expiryBuckets.get(bucket) ?? 0;
    limits.push({ name: `expiry bucket ${bucket}`, allowedCost: Math.max(0, budget.expiryBucket - inBucket) });

    // A user-set ceiling on one cadence. Only applied when they set one, so the
    // built-in profiles behave exactly as they did and as the backtest measured.
    const tenorCap = prof.maxPerTenor?.[opp.intervalSec];
    if (typeof tenorCap === "number") {
      const inTenor = positions.filter((p) => p.intervalSec === opp.intervalSec).reduce((s, p) => s + p.cost, 0);
      limits.push({
        name: `${tenorLabel(opp.intervalSec)} tenor cap ${(tenorCap * 100).toFixed(0)}%`,
        allowedCost: Math.max(0, totalCapital * tenorCap - inTenor),
      });
    }

    // --- what the book will actually supply ---------------------------------
    const allowedCost = Math.max(0, Math.min(...limits.map((l) => l.allowedCost)));
    const binding = limits.reduce((a, b) => (b.allowedCost < a.allowedCost ? b : a)).name;

    if (allowedCost <= 0) {
      decisions.push(skip(opp, binding, limits, exposureContext));
      continue;
    }
    // Refuse trades too small to be worth their spread. Without this the
    // allocator tops a leg up by a few cents every cycle, paying a round trip
    // each time to move a position it had essentially already reached.
    const minTrade = Math.max(MIN_TRADE_ABS, totalCapital * MIN_TRADE_FRACTION);
    if (allowedCost < minTrade) {
      decisions.push(
        skip(opp, `top-up of ${allowedCost.toFixed(2)} below minimum trade ${minTrade.toFixed(2)} — not worth the spread`, limits, exposureContext),
      );
      continue;
    }

    const fill = fillableFor(opp, book, allowedCost);
    if (fill.shares <= 0 || fill.cost <= 0) {
      decisions.push(skip(opp, "no depth at or below fair value", limits, exposureContext));
      continue;
    }
    const depthBound = fill.cost < allowedCost * 0.999;

    const pos: Position = {
      marketId: opp.marketId,
      asset: opp.asset,
      intervalSec: opp.intervalSec,
      leg: opp.leg,
      shares: fill.shares,
      entryPrice: fill.avgPrice,
      cost: fill.cost,
      expiry: opp.expiry,
      deltaPer1PctPerShare: dPerShare,
    };
    positions.push(pos);
    spent += fill.cost;

    decisions.push({
      opportunity: opp,
      action: "BUY",
      shares: fill.shares,
      cost: fill.cost,
      avgPrice: fill.avgPrice,
      kellyFull: kFull,
      kellyTarget,
      binding: depthBound ? "book depth at or below fair value" : binding,
      limits,
      exposure: { ...exposureContext, after: exposureBefore + fill.shares * dPerShare },
    });
  }

  // Legs that were never candidates still deserve a recorded reason: the "why"
  // panel is only trustworthy if it can account for everything it saw.
  for (const opp of input.opportunities) {
    if (decisions.some((d) => d.opportunity === opp)) continue;
    decisions.push(skip(opp, opp.blocked ?? (opp.edge !== null && opp.edge <= 0 ? "no positive edge" : "not a candidate"), []));
  }

  const riskAfter = riskOf(positions, rho);
  return {
    decisions,
    projected: positions,
    riskBefore,
    riskAfter,
    deployed: riskAfter.capitalAtRisk,
    cash: totalCapital - riskAfter.capitalAtRisk,
  };
}

/**
 * Shares of a given per-share delta that fit before |exposure| exceeds `limit`.
 *
 * Signed on purpose. A leg pushing exposure back toward zero gets room to run
 * all the way through neutral to the far side of the budget; a leg pushing
 * further out gets only what is left. Treating delta as a magnitude would refuse
 * the hedge and permit the concentration, which is exactly backwards.
 */
function headroom(existing: number, perShare: number, limit: number): number {
  if (Math.abs(perShare) < 1e-12) return Number.POSITIVE_INFINITY;
  const target = perShare > 0 ? limit : -limit;
  const room = (target - existing) / perShare;
  return Math.max(0, room);
}

/**
 * Rank candidates by edge per unit of the budget they actually consume.
 *
 * Raw edge is the wrong sort key here: the scarce resource is directional
 * exposure, not cash, so a leg with half the edge and a tenth of the delta is
 * the better use of the book.
 */
function score(o: Opportunity): number {
  const edge = o.edge ?? 0;
  const risk = Math.abs(o.deltaPerShare) > 0 ? Math.abs(o.deltaPerShare) : 1e-9;
  return edge / Math.sqrt(risk);
}

const skip = (
  opportunity: Opportunity,
  binding: string,
  limits: Decision["limits"],
  exposure?: Decision["exposure"],
): Decision => ({
  opportunity,
  action: "SKIP",
  shares: 0,
  cost: 0,
  avgPrice: 0,
  kellyFull: 0,
  kellyTarget: 0,
  binding,
  limits,
  // A refusal's exposure is unchanged by definition — `after` equals `before` —
  // and that identity is the whole message: this is what the portfolio already
  // carries, and it is why nothing was added to it.
  ...(exposure ? { exposure } : {}),
});
