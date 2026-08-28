// The baselines are evidence, so they have to be as checkable as evidence.
//
// A baseline that quietly stopped entering would not fail anything — it would
// just accumulate SKIPs and appear on the study with a tiny sample and a wide
// interval, which reads as "inconclusive" rather than as "broken". These tests
// exist so that failure mode is a red suite instead of a footnote.

import { describe, expect, it } from "vitest";
import { BASELINES, baselineBySlug, coinOf } from "./baselines.js";
import type { EventContext } from "./agent.js";

const ctx = (over: Partial<{
  ask: number | null; bid: number | null; depth: number;
  probability: number | null; secondsLeft: number; intervalSec: number;
  marketId: string; leg: "UP" | "DOWN";
}> = {}): EventContext => ({
  market: {
    marketId: over.marketId ?? "0x00000000000000000000000000000000000000000000000000000000000000ab",
    asset: "BTC",
    leg: over.leg ?? "UP",
    intervalSec: over.intervalSec ?? 900,
    expiry: 1_787_000_900,
    secondsLeft: over.secondsLeft ?? 800,
  },
  price: {
    bid: over.bid === undefined ? 0.58 : over.bid,
    ask: over.ask === undefined ? 0.6 : over.ask,
    depth: over.depth ?? 100,
  },
  reference: { spot: 77_000, probability: over.probability === undefined ? 0.62 : over.probability },
  limits: { maxNotional: 5 },
});

describe("every baseline is a well-formed agent", () => {
  it("has six of them, each with a distinct slug", () => {
    expect(BASELINES).toHaveLength(6);
    expect(new Set(BASELINES.map((b) => b.slug)).size).toBe(6);
  });

  it("states the hypothesis it is on the board to test", () => {
    for (const b of BASELINES) {
      expect(b.question.length, b.slug).toBeGreaterThan(10);
      expect(b.question.endsWith("?"), b.slug).toBe(true);
    }
  });

  it("never asks for more than Rivo allows", () => {
    for (const b of BASELINES) {
      // Ten shapes, including the ones that make a naive rule divide by zero.
      for (const c of [
        ctx(), ctx({ ask: 0.05 }), ctx({ ask: 0.95 }), ctx({ ask: null }), ctx({ bid: null }),
        ctx({ depth: 0 }), ctx({ probability: null }), ctx({ secondsLeft: 1 }),
        ctx({ secondsLeft: 899 }), ctx({ leg: "DOWN", ask: 0.4 }),
      ]) {
        const d = b.decide(c);
        expect(d.notional, b.slug).toBeGreaterThanOrEqual(0);
        expect(d.notional, b.slug).toBeLessThanOrEqual(c.limits.maxNotional);
        expect(["ENTER", "SKIP"], b.slug).toContain(d.action);
        if (d.action === "SKIP") expect(d.notional, b.slug).toBe(0);
      }
    }
  });

  it("declines rather than throwing when the book cannot be read", () => {
    for (const b of BASELINES) {
      const d = b.decide(ctx({ ask: null }));
      expect(d.action, b.slug).toBe("SKIP");
      expect(d.reason, b.slug).toBeTruthy();
    }
  });

  it("always says why", () => {
    for (const b of BASELINES) {
      expect(b.decide(ctx()).reason, b.slug).toBeTruthy();
    }
  });

  it("is reachable by slug", () => {
    expect(baselineBySlug("coin-flip")?.label).toBe("Coin flip");
    expect(baselineBySlug("nope")).toBeUndefined();
  });
});

describe("each rule actually implements the rule its name claims", () => {
  const decide = (slug: string, c: EventContext) => baselineBySlug(slug)!.decide(c);

  it("favourite enters above 0.5 and declines at or below it", () => {
    expect(decide("favourite", ctx({ ask: 0.62 })).action).toBe("ENTER");
    expect(decide("favourite", ctx({ ask: 0.5 })).action).toBe("SKIP");
    expect(decide("favourite", ctx({ ask: 0.38 })).action).toBe("SKIP");
  });

  it("longshot enters below 0.2 only", () => {
    expect(decide("longshot", ctx({ ask: 0.12 })).action).toBe("ENTER");
    expect(decide("longshot", ctx({ ask: 0.2 })).action).toBe("SKIP");
  });

  it("spread-aware needs both a tight spread and real depth", () => {
    expect(decide("spread-aware", ctx({ bid: 0.58, ask: 0.6, depth: 100 })).action).toBe("ENTER");
    expect(decide("spread-aware", ctx({ bid: 0.5, ask: 0.6, depth: 100 })).action).toBe("SKIP");
    expect(decide("spread-aware", ctx({ bid: 0.58, ask: 0.6, depth: 5 })).action).toBe("SKIP");
  });

  it("late-entry waits for the last fifth of the window", () => {
    // 900s window: 800 left is 11% elapsed, 100 left is 89%.
    expect(decide("late-entry", ctx({ secondsLeft: 800 })).action).toBe("SKIP");
    expect(decide("late-entry", ctx({ secondsLeft: 100 })).action).toBe("ENTER");
  });

  it("high-conviction demands more edge than production's 0.03 floor", () => {
    // +0.05 clears production and must NOT clear this one — that gap is the
    // whole hypothesis, so a change to either floor should fail here.
    expect(decide("high-conviction", ctx({ probability: 0.65, ask: 0.6 })).action).toBe("SKIP");
    expect(decide("high-conviction", ctx({ probability: 0.75, ask: 0.6 })).action).toBe("ENTER");
  });
});

describe("the coin is a control, so it has to be reproducible", () => {
  it("gives the same answer for the same window and leg", () => {
    expect(coinOf("0xabc", "UP")).toBe(coinOf("0xabc", "UP"));
  });

  it("separates the two legs of one window", () => {
    expect(coinOf("0xabc", "UP")).not.toBe(coinOf("0xabc", "DOWN"));
  });

  it("stays inside [0, 1)", () => {
    for (let i = 0; i < 500; i++) {
      const v = coinOf(`0x${i.toString(16)}`, i % 2 ? "UP" : "DOWN");
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is roughly fair over many windows — a control that never enters measures nothing", () => {
    let yes = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) if (coinOf(`0xmarket${i}`, "UP") >= 0.5) yes++;
    // Wide enough never to flake, tight enough to catch a hash that collapsed.
    expect(yes / n).toBeGreaterThan(0.42);
    expect(yes / n).toBeLessThan(0.58);
  });
});
