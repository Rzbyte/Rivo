// The maker planner decides how wide to quote, how big, and when to stand
// aside. Standing aside is the part worth testing hardest: a maker that quotes
// through a disagreement, or past the delta budget, is taking a directional view
// while believing it is earning a spread.

import { describe, expect, it } from "vitest";
import { legKey, planQuotes, scoreFills, type MakerInputs, type MakerFill } from "./maker.js";
import { PROFILES } from "../portfolio/profiles.js";
import type { Opportunity } from "../engine/opportunity.js";

const NOW = 1_800_000_000;

function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    marketId: "0xm",
    asset: "BTC",
    intervalSec: 3600,
    expiry: NOW + 3000,
    leg: "UP",
    fair: 0.6,
    ask: 0.62,
    bid: over.bid ?? null,
    mid: 0.6,
    edge: null,
    depthAtFair: 100,
    tauMinutes: 50,
    phase: 0.2,
    moneyness: 0.001,
    sigmaRemaining: 0.01,
    z: 0.1,
    deltaPerShare: 0.01,
    blocked: null,
    ...over,
  };
}

/**
 * Note the spread order: `...over` goes FIRST, so the merged `params` below
 * survives it. Written the other way round, a test overriding one param silently
 * blanks every other one — which is how three of these first failed.
 */
function inputs(over: Partial<MakerInputs> = {}): MakerInputs {
  return {
    profile: PROFILES.balanced,
    now: NOW,
    assetDelta: new Map(),
    inventory: new Map(),
    opportunities: [opp()],
    ...over,
    params: {
      halfSpread: 0.02,
      quoteSize: 10,
      maxDisagreement: 0.1,
      minSecondsLeft: 300,
      freeCash: 1000,
      assetDeltaBudget: 5,
      ...(over.params ?? {}),
    },
  };
}

describe("planQuotes — the spread", () => {
  it("quotes symmetrically around the model, not the book", () => {
    // The kit's own maker centres on the book mid and says so: swap in a signal
    // to actually make money. Centring on the model IS the difference.
    const r = planQuotes(inputs({ opportunities: [opp({ fair: 0.6, mid: 0.5 })] }));
    const bid = r.quotes.find((q) => q.side === "buy")!;
    expect(bid.price).toBeCloseTo(0.58, 10);
  });

  it("only rests an ask when the leg is actually held", () => {
    // No naked short: selling needs the token. Without inventory a maker is
    // just a slow buyer, and the plan should say so rather than fail on-chain.
    const none = planQuotes(inputs());
    expect(none.quotes.some((q) => q.side === "sell")).toBe(false);
    expect(none.needsInventory).toHaveLength(1);

    const held = planQuotes(inputs({ inventory: new Map([[legKey("0xm", "UP"), 10]]) }));
    const ask = held.quotes.find((q) => q.side === "sell")!;
    expect(ask.price).toBeCloseTo(0.62, 10);
    expect(ask.size).toBe(10);
  });

  it("caps the ask at what is held, not at the requested size", () => {
    const r = planQuotes(inputs({ inventory: new Map([[legKey("0xm", "UP"), 3]]) }));
    expect(r.quotes.find((q) => q.side === "sell")!.size).toBe(3);
  });
});

describe("planQuotes — standing aside", () => {
  it("refuses to quote through a large model/book disagreement", () => {
    // Quoting through a gap this size is taking a view, and the taker backtest
    // measured what views cost here.
    const r = planQuotes(inputs({ opportunities: [opp({ fair: 0.9, mid: 0.5 })] }));
    expect(r.quotes).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/ceiling/);
  });

  it("stands aside near expiry", () => {
    const r = planQuotes(inputs({ opportunities: [opp({ expiry: NOW + 60 })] }));
    expect(r.quotes).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/to expiry/);
  });

  it("drops only the side whose spread the clamp ate", () => {
    // At fair 0.999 the ask clamps back to 0.999 and would sell at exactly fair,
    // capturing nothing while still carrying the risk. The bid at 0.949 is
    // perfectly good, so the market is not abandoned — only the ask is.
    const r = planQuotes(inputs({
      opportunities: [opp({ fair: 0.999, mid: 0.999 })],
      inventory: new Map([[legKey("0xm", "UP"), 10]]),
      params: { halfSpread: 0.05 } as MakerInputs["params"],
    }));
    expect(r.quotes.some((q) => q.side === "buy")).toBe(true);
    expect(r.quotes.some((q) => q.side === "sell")).toBe(false);
    expect(r.skipped.some((x) => /capturing nothing/.test(x.reason))).toBe(true);
    expect(r.quotes.every((q) => q.price > 0 && q.price < 1)).toBe(true);
  });
});

describe("planQuotes — inventory is a position", () => {
  it("shrinks the bid as the asset delta budget fills", () => {
    // This is what ec-maker has no notion of: passive inventory still moves the
    // portfolio, so the budget governs it exactly as it governs a taken position.
    const wide = planQuotes(inputs({ assetDelta: new Map([["BTC", 0]]) }));
    const tight = planQuotes(inputs({ assetDelta: new Map([["BTC", 4.9]]) }));
    const w = wide.quotes.find((q) => q.side === "buy")!.size;
    const t = tight.quotes.find((q) => q.side === "buy")?.size ?? 0;
    expect(t).toBeLessThan(w);
    expect(tight.quotes.find((q) => q.side === "buy")?.binding ?? tight.skipped[0]?.reason).toMatch(/delta/);
  });

  it("stops bidding once the budget is spent", () => {
    const r = planQuotes(inputs({ assetDelta: new Map([["BTC", 5]]) }));
    expect(r.quotes.some((q) => q.side === "buy")).toBe(false);
  });

  it("caps the bid by free cash", () => {
    const r = planQuotes(inputs({ params: { freeCash: 1 } as MakerInputs["params"] }));
    const bid = r.quotes.find((q) => q.side === "buy");
    expect(bid!.size * bid!.price).toBeLessThanOrEqual(1 + 1e-9);
    expect(bid!.binding).toBe("free cash");
  });

  it("rounds sizes down to the venue's lot", () => {
    // A size of 9.749193… reverts where 3.71 fills; never send the former.
    const r = planQuotes(inputs({ params: { quoteSize: 9.749193184999303 } as MakerInputs["params"] }));
    const bid = r.quotes.find((q) => q.side === "buy")!;
    expect(Number.isInteger(bid.size * 100)).toBe(true);
    expect(bid.size).toBeLessThanOrEqual(9.749193184999303);
  });

  it("prices one entry per market, from the UP leg only", () => {
    // Both legs of one market are the same economic position; quoting each
    // independently would double the inventory needed for no extra exposure.
    const r = planQuotes(inputs({ opportunities: [opp({ leg: "UP" }), opp({ leg: "DOWN", fair: 0.4 })] }));
    expect(r.quotes.every((q) => q.leg === "UP")).toBe(true);
  });
});

describe("scoreFills", () => {
  const fill = (over: Partial<MakerFill> = {}): MakerFill => ({
    at: NOW, marketId: "0xm", leg: "UP", side: "sell", price: 0.62, size: 10, fairAtQuote: 0.6, ...over,
  });

  it("counts spread captured against our own fair value", () => {
    const m = scoreFills([fill()], new Map());
    expect(m.capturedSpreadPerShare).toBeCloseTo(0.02, 10);
  });

  it("counts a buy below fair as capture too", () => {
    const m = scoreFills([fill({ side: "buy", price: 0.58 })], new Map());
    expect(m.capturedSpreadPerShare).toBeCloseTo(0.02, 10);
  });

  it("reports adverse selection separately from capture", () => {
    // A maker profits only when capture exceeds adverse selection. Collapsing
    // them into one number hides which side of that inequality it is on.
    const m = scoreFills([fill()], new Map([[legKey("0xm", "UP"), 0.7]]));
    expect(m.capturedSpreadPerShare).toBeCloseTo(0.02, 10);
    expect(m.adverseSelectionPerShare).toBeCloseTo(-0.1, 10); // sold, then the model rose
  });

  it("separates paired shares from one-sided inventory", () => {
    const m = scoreFills([fill({ side: "buy", size: 10 }), fill({ side: "sell", size: 6 })], new Map());
    expect(m.oneSidedShares).toBeCloseTo(4, 10);
    expect(m.pairedShares).toBeCloseTo(12, 10); // 6 bought + 6 sold offset
    expect(m.maxInventoryShares).toBeCloseTo(4, 10);
  });

  it("handles an empty run without dividing by zero", () => {
    const m = scoreFills([], new Map());
    expect(m.capturedSpreadPerShare).toBe(0);
    expect(m.fills).toBe(0);
  });
});
