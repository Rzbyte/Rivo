// A realized frequency is only a measurement if you can say what it measured.
//
// "Comparable contracts settled true 3.3%" beside a price of 0.02 is unreadable
// on its own. Three different questions have the same answer shape and only one
// of them is being answered:
//
//   - contracts quoted NEAR 0.02 settled true 3.3% of the time    ← this one
//   - BTC 15m contracts settled true 3.3% of the time
//   - all contracts settled true 3.3% of the time
//
// So every card carries the population, the price band, the sample size, the
// date range, the interval and whether the most specific cohort was the one that
// answered. Never silently mixing BTC with ETH, or 15m with 1d, while presenting
// the result as market-specific.

import { describe, expect, it } from "vitest";
import { lookupCohort, cohortKey, type CalibrationReport } from "./calibration.js";
import { marketsView } from "./markets.js";

/** A report with one usable bucket, over a stated period. */
const report = (over: Partial<CalibrationReport> = {}): CalibrationReport =>
  ({
    buckets: [
      { lo: 0, hi: 0.2, n: 400, windows: 120, quoted: 0.1, realized: 0.08, gap: -0.02, se: 0.02, lo95: 0.04, hi95: 0.12, thin: false },
      { lo: 0.2, hi: 0.4, n: 60, windows: 8, quoted: 0.3, realized: 0.25, gap: -0.05, se: 0.15, lo95: 0, hi95: 0.55, thin: true },
    ],
    n: 460, windows: 128, from: 1_784_718_900, to: 1_787_178_600,
    basis: "window", executableOnly: true, minWindows: 30,
    brier: 0.16, brierBase: 0.25, skill: 0.36, baseRate: 0.5,
    ...over,
  }) as CalibrationReport;

describe("cohort disclosure", () => {
  it("answers from the most specific cohort and says which", () => {
    const reports = new Map<string, CalibrationReport>([
      [cohortKey({ asset: "BTC", intervalSec: 900 }), report()],
      [cohortKey({ asset: null, intervalSec: null }), report()],
    ]);
    const hit = lookupCohort(reports, "BTC", 900, 0.1);
    expect(hit.cohort).toEqual({ asset: "BTC", intervalSec: 900 });
    expect(hit.fellBack).toBe(false);
  });

  it("widens only on sample size, and admits it did", () => {
    // The specific cohort exists but its bucket is thin, so a wider one answers
    // — and `fellBack` is how the card is required to say so.
    const thinOnly = report({
      buckets: [{ lo: 0.2, hi: 0.4, n: 9, windows: 3, quoted: 0.3, realized: 0.33, gap: 0.03, se: 0.27, lo95: 0, hi95: 0.86, thin: true }],
    } as Partial<CalibrationReport>);
    // The wider cohort must have a THICK bucket covering the same price, or
    // nothing thicker exists and the specific-but-thin answer is correct.
    const wider = report({
      buckets: [{ lo: 0.2, hi: 0.4, n: 900, windows: 210, quoted: 0.3, realized: 0.28, gap: -0.02, se: 0.03, lo95: 0.22, hi95: 0.34, thin: false }],
    } as Partial<CalibrationReport>);
    const reports = new Map<string, CalibrationReport>([
      [cohortKey({ asset: "BTC", intervalSec: 900 }), thinOnly],
      [cohortKey({ asset: "BTC", intervalSec: null }), wider],
    ]);
    const hit = lookupCohort(reports, "BTC", 900, 0.3);
    expect(hit.fellBack).toBe(true);
    expect(hit.cohort).toEqual({ asset: "BTC", intervalSec: null });
  });

  it("never answers a BTC market from an ETH cohort", () => {
    // The chain is BTC 15m → BTC all tenors → all assets 15m → global. An
    // asset-specific cohort for the OTHER asset must never be reachable, because
    // presenting it as market-specific would be the exact silent mixing this
    // whole mechanism exists to prevent.
    const reports = new Map<string, CalibrationReport>([
      [cohortKey({ asset: "ETH", intervalSec: 900 }), report()],
    ]);
    const hit = lookupCohort(reports, "BTC", 900, 0.1);
    expect(hit.bucket).toBeNull();
    expect(hit.cohort).toEqual({ asset: "BTC", intervalSec: 900 });
  });

  it("carries the period the answering cohort was measured over", () => {
    // A rate with no date range cannot be checked against anything.
    const reports = new Map<string, CalibrationReport>([
      [cohortKey({ asset: "BTC", intervalSec: 900 }), report()],
    ]);
    const hit = lookupCohort(reports, "BTC", 900, 0.1);
    expect(hit.period).toEqual({ from: 1_784_718_900, to: 1_787_178_600, windows: 128 });
  });

  it("puts every checkable field on the card itself", () => {
    // The list a sceptic asks for, in one object: which contracts, in which
    // price band, over how many settled windows, between which dates, with what
    // uncertainty, and whether the specific cohort answered.
    const view = marketsView(
      {
        at: 1_787_000_000,
        opportunities: [
          {
            marketId: "0xm", asset: "BTC", leg: "UP", intervalSec: 900, expiry: 1_787_003_600,
            bid: 0.09, ask: 0.1, mid: 0.095, fair: 0.12, edge: 0.02,
            depthAtFair: 40, deltaPerShare: 0.5, blocked: null,
          },
        ],
        assets: new Map([["BTC", { spot: 64_000, sigma: 0.0002 }]]),
        books: new Map(),
        unpriced: [],
      } as never,
      new Map<string, CalibrationReport>([[cohortKey({ asset: "BTC", intervalSec: 900 }), report()]]),
    );
    const h = view.cards[0]?.historical;
    expect(h, "no historical block on the card").toBeTruthy();
    expect(h!.cohortLabel).toBe("BTC 15m");
    expect(h!.bucket).toEqual({ lo: 0, hi: 0.2 });
    expect(h!.windows).toBe(120);
    expect(h!.lo95).toBeCloseTo(0.04, 6);
    expect(h!.hi95).toBeCloseTo(0.12, 6);
    expect(h!.from).toBe(1_784_718_900);
    expect(h!.to).toBe(1_787_178_600);
    expect(h!.fellBack).toBe(false);
  });
});
