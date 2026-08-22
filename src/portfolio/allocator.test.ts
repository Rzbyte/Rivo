// The allocator is where a sizing mistake turns into a real position, and two of
// its bugs reached a live run before anything caught them. Both are pinned here.

import { describe, expect, it } from "vitest";
import { allocate, kellyFraction, type AllocatorInputs } from "./allocator.js";
import { PROFILES } from "./profiles.js";
import { buildBook, type MarketBook, type RestingOrder } from "../engine/book.js";
import type { Opportunity } from "../engine/opportunity.js";
import type { Position } from "./risk.js";
import type { Asset } from "../core/config.js";

const SPOT: Record<Asset, number> = { BTC: 68000, ETH: 2100 };

/** A leg the allocator would want: cheap, liquid, and not blocked. */
function opp(over: Partial<Opportunity> = {}): Opportunity {
  const fair = over.fair ?? 0.6;
  const ask = over.ask ?? 0.5;
  return {
    marketId: "0xmarket1",
    asset: "BTC",
    intervalSec: 3600,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    leg: "UP",
    fair,
    ask,
    bid: over.bid ?? null,
    mid: ask,
    edge: fair - ask,
    depthAtFair: 1000,
    tauMinutes: 60,
    phase: 0.5,
    moneyness: 0.001,
    sigmaRemaining: 0.01,
    z: 0.1,
    // Small enough that the delta budget is not the binding constraint unless a
    // test deliberately makes it so.
    deltaPerShare: 1e-6,
    blocked: null,
    ...over,
  };
}

/**
 * A book offering `size` of the given LEG at `price`.
 *
 * The side has to match the crossing path or the leg has no asks at all: buying
 * UP crosses resting SELL_YES, buying DOWN crosses resting BUY_YES at the
 * complement. Writing this helper as SELL_YES-only made a hedge test fail for
 * want of liquidity that was never offered — which is the same mistake a depth
 * model reading one side of the raw book would make in production.
 */
function bookFor(leg: "UP" | "DOWN", price: number, size = 100_000): MarketBook {
  const orders: RestingOrder[] =
    leg === "UP" ? [{ side: "SELL_YES", price, size }] : [{ side: "BUY_YES", price: 1 - price, size }];
  return buildBook(orders);
}

/** Both legs quotable, so a test only constrains what it means to constrain. */
function deepBook(price: number, size = 100_000): MarketBook {
  return buildBook([
    { side: "SELL_YES", price, size },
    { side: "BUY_YES", price: 1 - price, size },
  ]);
}

function inputs(over: Partial<AllocatorInputs> = {}): AllocatorInputs {
  const o = over.opportunities ?? [opp()];
  const books = over.books ?? new Map(o.map((x) => [x.marketId, deepBook(x.ask ?? 0.5)]));
  return {
    totalCapital: 100,
    freeCash: 100,
    opportunities: o,
    books,
    spot: new Map<Asset, number>([["BTC", SPOT.BTC], ["ETH", SPOT.ETH]]),
    held: [],
    rho: 0.8,
    profile: PROFILES.balanced,
    ...over,
  };
}

function held(over: Partial<Position> = {}): Position {
  return {
    marketId: "0xmarket1",
    asset: "BTC",
    intervalSec: 3600,
    leg: "UP",
    shares: 10,
    entryPrice: 0.5,
    cost: 5,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    deltaPer1PctPerShare: 0.001,
    ...over,
  };
}

describe("kellyFraction", () => {
  it("is the textbook binary stake", () => {
    // Pay 0.5 for something worth 0.6: (0.6 - 0.5) / (1 - 0.5) = 0.2
    expect(kellyFraction(0.6, 0.5)).toBeCloseTo(0.2, 10);
  });

  it("is zero or negative when there is no edge, so nothing is sized", () => {
    expect(kellyFraction(0.5, 0.5)).toBe(0);
    expect(kellyFraction(0.4, 0.5)).toBeLessThan(0);
  });

  it("refuses degenerate prices instead of returning Infinity", () => {
    expect(kellyFraction(0.6, 0)).toBe(0);
    expect(kellyFraction(0.6, 1)).toBe(0);
  });
});

describe("allocate — per-leg targets (regression)", () => {
  // The bug: caps were applied per ORDER, so repeated cycles stacked far past
  // them in one leg, in fragments that each paid a spread to open.
  it("counts existing holdings against the position cap", () => {
    const balanced = PROFILES.balanced; // maxPerPosition 0.2 -> 20 of 100
    const alreadyIn = held({ cost: 20 });
    const r = allocate(inputs({ held: [alreadyIn], freeCash: 80 }));
    const buy = r.decisions.find((d) => d.action === "BUY");
    expect(buy).toBeUndefined();
    const skip = r.decisions.find((d) => d.opportunity.marketId === "0xmarket1");
    expect(skip?.action).toBe("SKIP");
    expect(balanced.maxPerPosition * 100).toBe(20);
  });

  it("tops a leg up only to its target, not by a fresh full stake", () => {
    // Kelly here wants 0.2 * 0.5 * 100 = 10. With 6 already held, at most 4 more.
    const r = allocate(inputs({ held: [held({ cost: 6 })], freeCash: 94 }));
    const buy = r.decisions.find((d) => d.action === "BUY");
    expect(buy).toBeDefined();
    expect(buy!.cost).toBeLessThanOrEqual(4 + 1e-9);
  });

  it("refuses top-ups too small to be worth the spread", () => {
    // 9.9 of a 10 target leaves 0.1 — below the 1-of-100 minimum trade.
    const r = allocate(inputs({ held: [held({ cost: 9.9 })], freeCash: 90 }));
    const d = r.decisions.find((x) => x.opportunity.marketId === "0xmarket1");
    expect(d?.action).toBe("SKIP");
    expect(d?.binding).toMatch(/below minimum trade/);
  });
});

describe("allocate — the portfolio layer earning its keep", () => {
  it("skips a genuinely profitable leg when the asset budget is spent", () => {
    // Two BTC legs, both with real edge. This is the demo: the second is the
    // same directional view at another tenor, and a signal bot takes both.
    const big = opp({ marketId: "0xa", deltaPerShare: 5e-4, fair: 0.7, ask: 0.5 });
    const second = opp({ marketId: "0xb", intervalSec: 900, deltaPerShare: 5e-4, fair: 0.65, ask: 0.5 });
    const r = allocate(
      inputs({
        opportunities: [big, second],
        books: new Map([
          ["0xa", deepBook(0.5)],
          ["0xb", deepBook(0.5)],
        ]),
      }),
    );
    const byId = new Map(r.decisions.map((d) => [d.opportunity.marketId, d]));
    expect(byId.get("0xa")?.action).toBe("BUY");
    expect(byId.get("0xb")?.action).toBe("SKIP");
    expect(byId.get("0xb")?.binding).toMatch(/delta budget/);
    // And the budget really is spent, not merely approached.
    const btc = r.riskAfter.assetDelta.get("BTC") ?? 0;
    expect(Math.abs(btc)).toBeGreaterThan(100 * PROFILES.balanced.maxAssetDeltaPer1Pct * 0.95);
  });

  it("gives an offsetting leg room that an adding leg does not get", () => {
    // Signed headroom. Evaluated against the SAME starting portfolio, a DOWN leg
    // that pulls exposure back toward zero should be allowed where an UP leg of
    // the same size is refused. They have to be tested separately: run together,
    // the hedge fills first and frees budget for the other, which is correct
    // behaviour but a different claim.
    const longBtcAtBudget = held({ shares: 100, deltaPer1PctPerShare: 0.05, cost: 5 }); // +5.0 vs a 5.0 budget
    const base = { held: [longBtcAtBudget], freeCash: 95 };

    const hedge = opp({ marketId: "0xh", leg: "DOWN", deltaPerShare: -5e-4, fair: 0.7, ask: 0.5 });
    const hedgeRun = allocate(
      inputs({ ...base, opportunities: [hedge], books: new Map([["0xh", bookFor("DOWN", 0.5)]]) }),
    );
    expect(hedgeRun.decisions[0]!.action).toBe("BUY");

    const adds = opp({ marketId: "0xu", leg: "UP", deltaPerShare: 5e-4, fair: 0.7, ask: 0.5 });
    const addRun = allocate(
      inputs({ ...base, opportunities: [adds], books: new Map([["0xu", bookFor("UP", 0.5)]]) }),
    );
    expect(addRun.decisions[0]!.action).toBe("SKIP");
    expect(addRun.decisions[0]!.binding).toMatch(/delta budget/);
  });

  it("frees budget for a further position once a hedge has been taken", () => {
    // The other half of the same mechanic, asserted deliberately rather than by
    // accident: exposure is what is scarce, so reducing it creates capacity.
    const longBtcAtBudget = held({ shares: 100, deltaPer1PctPerShare: 0.05, cost: 5 });
    const hedge = opp({ marketId: "0xh", leg: "DOWN", deltaPerShare: -5e-4, fair: 0.7, ask: 0.5 });
    const adds = opp({ marketId: "0xu", leg: "UP", deltaPerShare: 5e-4, fair: 0.7, ask: 0.5 });
    const r = allocate(
      inputs({
        held: [longBtcAtBudget],
        freeCash: 95,
        opportunities: [hedge, adds],
        books: new Map([
          ["0xh", bookFor("DOWN", 0.5)],
          ["0xu", bookFor("UP", 0.5)],
        ]),
      }),
    );
    const byId = new Map(r.decisions.map((d) => [d.opportunity.marketId, d]));
    expect(byId.get("0xh")?.action).toBe("BUY");
    expect(byId.get("0xu")?.action).toBe("BUY");
    // And the result still respects the budget it was working against.
    const btc = Math.abs(r.riskAfter.assetDelta.get("BTC") ?? 0);
    expect(btc).toBeLessThanOrEqual(100 * PROFILES.balanced.maxAssetDeltaPer1Pct + 1e-6);
  });

  it("never sizes past what the book will supply at or below fair value", () => {
    // Kelly wants 10; the book only has 3 shares at an acceptable price.
    const thin = new Map([["0xmarket1", buildBook([{ side: "SELL_YES", price: 0.5, size: 3 }])]]);
    const r = allocate(inputs({ books: thin }));
    const buy = r.decisions.find((d) => d.action === "BUY");
    expect(buy!.shares).toBeLessThanOrEqual(3);
    expect(buy!.binding).toMatch(/depth/);
  });

  it("holds cash when nothing clears the profile's edge floor", () => {
    const r = allocate(inputs({ opportunities: [opp({ fair: 0.51, ask: 0.5 })] }));
    expect(r.decisions.every((d) => d.action === "SKIP")).toBe(true);
    expect(r.deployed).toBe(0);
    expect(r.cash).toBe(100);
  });

  it("records a reason for every leg it saw, including blocked ones", () => {
    // The "why" panel is only trustworthy if nothing is silently dropped.
    const legs = [opp({ marketId: "0x1" }), opp({ marketId: "0x2", blocked: "no offer on this leg", ask: null, edge: null })];
    const r = allocate(inputs({ opportunities: legs, books: new Map([["0x1", deepBook(0.5)]]) }));
    expect(r.decisions).toHaveLength(2);
    for (const d of r.decisions) expect(d.binding.length).toBeGreaterThan(0);
  });
});

describe("the refusal the product exists to make", () => {
  // Three windows on one underlying, each with genuine positive edge. A strategy
  // scoring markets independently buys all three and discovers it has one
  // directional view at triple size. This is the test for the alternative.
  const btcTenors = [900, 3600, 14400];

  /** Three BTC UP legs, same view, different tenors, all attractive on their own. */
  function threeBtcWindows(): Opportunity[] {
    return btcTenors.map((intervalSec, i) =>
      opp({
        marketId: `0xbtc${i}`,
        intervalSec,
        // Each is a real edge, and they differ so there is a best one.
        fair: 0.62 - i * 0.02,
        ask: 0.5,
        edge: 0.12 - i * 0.02,
        // Big enough that the DELTA budget binds before the per-position cost cap
        // does — otherwise this fixture tests the cost cap and quietly proves
        // nothing about correlated exposure.
        //
        //   budget      100 x 0.05                       = 5.00 per 1%
        //   per share   5e-4 x 68000 x 0.01              = 0.34 per 1%
        //   cost cap    100 x 0.2 = 20 -> 40 shares      = 13.6 per 1%
        //
        // So one leg exhausts the budget at ~15 shares, well inside what the
        // cost cap would have allowed.
        deltaPerShare: 5e-4,
      }),
    );
  }

  it("does not buy the same view three times", () => {
    const o = threeBtcWindows();
    const a = allocate(inputs({ opportunities: o }));
    const bought = a.decisions.filter((d) => d.action === "BUY");
    expect(bought.length).toBeGreaterThan(0);
    expect(bought.length).toBeLessThan(o.length);

    // Whatever it took, the resulting BTC exposure respects the budget — which
    // is the actual guarantee. "Bought fewer" without that would just be luck.
    const cap = 100 * PROFILES.balanced.maxAssetDeltaPer1Pct;
    const delta = a.riskAfter.assetDelta.get("BTC") ?? 0;
    expect(Math.abs(delta)).toBeLessThanOrEqual(cap + 1e-9);
  });

  it("names the correlated budget as the reason, not a generic refusal", () => {
    // The reason string reaches a user's screen. "Skipped" is useless; "BTC
    // delta budget" is the whole argument.
    const a = allocate(inputs({ opportunities: threeBtcWindows() }));
    const refused = a.decisions.filter((d) => d.action === "SKIP");
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.some((d) => /delta budget/i.test(d.binding))).toBe(true);
  });

  it("reports the exposure arithmetic behind each decision", () => {
    const a = allocate(inputs({ opportunities: threeBtcWindows() }));
    const cap = 100 * PROFILES.balanced.maxAssetDeltaPer1Pct;

    for (const d of a.decisions) {
      // Every leg that reached the delta budget carries its arithmetic; the
      // ones rejected earlier legitimately do not, and must not invent it.
      if (!d.exposure) continue;
      expect(d.exposure.cap).toBeCloseTo(cap, 10);
      if (d.action === "SKIP") {
        // A refusal changes nothing, and saying so is the point of showing it.
        expect(d.exposure.after).toBe(d.exposure.before);
      } else {
        expect(d.exposure.after).not.toBe(d.exposure.before);
      }
    }

    // At least one refusal happened with the budget already spent — the case the
    // dashboard renders as "the budget for BTC was already spent by another
    // tenor".
    const spent = a.decisions.filter(
      (d) => d.action === "SKIP" && d.exposure && Math.abs(d.exposure.before) > 0.9 * d.exposure.cap,
    );
    expect(spent.length).toBeGreaterThan(0);
  });

  it("accumulates exposure across the pass, not from the state it started in", () => {
    // The figure a refusal is judged against has to include what was taken
    // EARLIER IN THE SAME CYCLE, or the second leg is measured against a
    // portfolio that no longer exists by the time it is considered.
    const a = allocate(inputs({ opportunities: threeBtcWindows() }));
    const withExposure = a.decisions.filter((d) => d.exposure);
    const firstBefore = Math.abs(withExposure[0]?.exposure?.before ?? 0);
    const lastBefore = Math.abs(withExposure[withExposure.length - 1]?.exposure?.before ?? 0);
    expect(lastBefore).toBeGreaterThan(firstBefore);
  });

  it("still takes an uncorrelated leg while refusing a correlated one", () => {
    // The behaviour that distinguishes a portfolio manager from a rate limiter.
    // ETH is a different underlying with its own budget, so it is not refused
    // just because BTC's is spent.
    const o = [
      ...threeBtcWindows(),
      opp({ marketId: "0xeth", asset: "ETH", intervalSec: 3600, fair: 0.6, ask: 0.5, edge: 0.1, deltaPerShare: 1.6e-2 }),
    ];
    const a = allocate(inputs({ opportunities: o }));
    const boughtAssets = a.decisions.filter((d) => d.action === "BUY").map((d) => d.opportunity.asset);
    expect(boughtAssets).toContain("ETH");
    expect(a.decisions.filter((d) => d.action === "SKIP" && d.opportunity.asset === "BTC").length).toBeGreaterThan(0);
  });

  it("lets an OFFSETTING leg through, where an identical same-direction leg is refused", () => {
    // Signed, not absolute. A DOWN leg against existing UP exposure is a hedge,
    // and treating delta as a magnitude would refuse the hedge and permit the
    // concentration — exactly backwards.
    //
    // Note what is NOT asserted: that the result is closer to zero. `headroom`
    // deliberately lets an offsetting leg run all the way through neutral to the
    // far side of the budget, so a large enough hedge legitimately ends up
    // pointing the other way. The guarantee is the BUDGET, not the direction —
    // and an earlier version of this test asserted the direction and failed
    // against behaviour the allocator documents.
    const existing = () => held({ marketId: "0xbtc0", shares: 100, deltaPer1PctPerShare: 0.02, cost: 20 });
    const cap = 100 * PROFILES.balanced.maxAssetDeltaPer1Pct;

    const hedge = opp({ marketId: "0xbtc9", leg: "DOWN", fair: 0.6, ask: 0.5, edge: 0.1, deltaPerShare: -5e-4 });
    const hedged = allocate(
      inputs({ opportunities: [hedge], held: [existing()], books: new Map([["0xbtc9", deepBook(0.5)]]) }),
    );
    expect(hedged.decisions.find((d) => d.opportunity.marketId === "0xbtc9")?.action).toBe("BUY");
    expect(Math.abs(hedged.riskAfter.assetDelta.get("BTC") ?? 0)).toBeLessThanOrEqual(cap + 1e-9);

    // The same leg pointing the SAME way as what is already held is capped far
    // harder, because it concentrates rather than offsets.
    const doubleDown = opp({ marketId: "0xbtc9", leg: "UP", fair: 0.6, ask: 0.5, edge: 0.1, deltaPerShare: 5e-4 });
    const concentrated = allocate(
      inputs({ opportunities: [doubleDown], held: [existing()], books: new Map([["0xbtc9", deepBook(0.5)]]) }),
    );
    const same = concentrated.decisions.find((d) => d.opportunity.marketId === "0xbtc9");
    const hedgeShares = hedged.decisions.find((d) => d.opportunity.marketId === "0xbtc9")?.shares ?? 0;
    expect(same?.shares ?? 0).toBeLessThan(hedgeShares);
    expect(Math.abs(concentrated.riskAfter.assetDelta.get("BTC") ?? 0)).toBeLessThanOrEqual(cap + 1e-9);
  });
});
