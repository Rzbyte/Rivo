// The book model decides how much Rivo can actually buy, so getting it wrong is
// silent: orders simply fill smaller than the sizer asked for, which reads as
// bad liquidity rather than a bug. The dual crossing path is the subtle part and
// the reason this file exists.

import { describe, expect, it } from "vitest";
import { bestAsk, bestBid, buildBook, depthAtOrBetter, mid, simulateBuy, type RestingOrder } from "./book.js";

const o = (side: string, price: number, size: number): RestingOrder => ({ side, price, size });

describe("buildBook", () => {
  it("routes each leg to the orders it can actually cross", () => {
    // Buying DOWN crosses resting BUY_YES (mint-a-pair), not SELL_YES. A model
    // that reads only SELL_YES sees no Down liquidity at all here.
    const book = buildBook([o("BUY_YES", 0.4, 100), o("SELL_YES", 0.45, 50)]);

    expect(bestAsk(book.UP)).toBe(0.45); // cross the SELL_YES
    expect(bestBid(book.UP)).toBe(0.4); // hit the BUY_YES

    expect(bestAsk(book.DOWN)).toBeCloseTo(0.6, 10); // 1 - 0.4, from the BUY_YES
    expect(bestBid(book.DOWN)).toBeCloseTo(0.55, 10); // 1 - 0.45, from the SELL_YES
  });

  it("finds Down-side depth where a one-sided reader would find none", () => {
    // The measured venue shape: many resting BUY_YES, few SELL_YES.
    const book = buildBook([o("BUY_YES", 0.3, 200), o("BUY_YES", 0.28, 300)]);
    expect(book.UP.asks).toHaveLength(0); // nothing to buy UP from
    expect(book.DOWN.asks).toHaveLength(2); // but 500 shares of DOWN available
    expect(depthAtOrBetter(book.DOWN, 0.75)).toBe(500);
  });

  it("merges equal prices so depth is size, not order count", () => {
    const book = buildBook([o("SELL_YES", 0.5, 10), o("SELL_YES", 0.5, 15), o("SELL_YES", 0.6, 5)]);
    expect(book.UP.asks).toEqual([
      { price: 0.5, size: 25 },
      { price: 0.6, size: 5 },
    ]);
  });

  it("drops orders outside (0,1) and non-positive sizes rather than pricing them", () => {
    const book = buildBook([o("SELL_YES", 0, 10), o("SELL_YES", 1, 10), o("SELL_YES", 0.5, 0), o("SELL_YES", 0.5, 4)]);
    expect(book.UP.asks).toEqual([{ price: 0.5, size: 4 }]);
  });

  it("ignores sides it does not recognise instead of guessing", () => {
    const book = buildBook([o("BUY_NO", 0.4, 100)]);
    expect(book.UP.asks).toHaveLength(0);
    expect(book.DOWN.asks).toHaveLength(0);
  });
});

describe("simulateBuy", () => {
  const book = buildBook([o("SELL_YES", 0.5, 10), o("SELL_YES", 0.55, 10), o("SELL_YES", 0.6, 10)]);

  it("walks the ladder and reports the true average, not the touch", () => {
    const fill = simulateBuy(book.UP, 25, 0.6);
    expect(fill.size).toBe(25);
    expect(fill.cost).toBeCloseTo(10 * 0.5 + 10 * 0.55 + 5 * 0.6, 10);
    expect(fill.avgPrice).toBeCloseTo(fill.cost / 25, 10);
    expect(fill.worstPrice).toBe(0.6);
  });

  it("stops at the limit price rather than paying through it", () => {
    const fill = simulateBuy(book.UP, 30, 0.55);
    expect(fill.size).toBe(20); // the 0.60 level is refused
    expect(fill.worstPrice).toBe(0.55);
  });

  it("returns a partial fill when the book cannot supply the size", () => {
    // The whole point: an allocator told it filled 100 would size against depth
    // that was never there.
    const fill = simulateBuy(book.UP, 100, 0.99);
    expect(fill.size).toBe(30);
  });

  it("fills nothing when the best ask is above the limit", () => {
    const fill = simulateBuy(book.UP, 10, 0.4);
    expect(fill.size).toBe(0);
    expect(fill.cost).toBe(0);
    expect(fill.avgPrice).toBe(0);
  });
});

describe("mid", () => {
  it("is null when a side is empty — never invented from one side", () => {
    expect(mid(buildBook([o("SELL_YES", 0.5, 10)]).UP)).toBeNull();
    expect(mid(buildBook([o("BUY_YES", 0.5, 10)]).UP)).toBeNull();
    expect(mid(buildBook([o("BUY_YES", 0.4, 10), o("SELL_YES", 0.6, 10)]).UP)).toBeCloseTo(0.5, 10);
  });
});
