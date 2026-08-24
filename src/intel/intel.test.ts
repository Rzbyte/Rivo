// Calibration and assessment, where the arithmetic has to be right because the
// product's central claim rests on it.
//
// "Is 67% actually 67%?" is only worth asking if the answer is computed
// honestly, and the two ways to get it wrong are both easy: count correlated
// snapshots as independent evidence, and quote a bucket built from four
// settled windows as though it were a finding.

import { describe, expect, it } from "vitest";
import { calibrate, onePerWindow, DEFAULT_EDGES, type CalibrationReport } from "./calibration.js";
import { assess, RULES, ASSESSMENT_LABEL, ASSESSMENT_TONE, type AssessmentCode } from "./assessment.js";
import type { Observation } from "../research/dataset.js";

const obs = (o: Partial<Observation> = {}): Observation => ({
  at: 1_000, marketId: "m1", asset: "BTC", intervalSec: 900, expiry: 2_000, leg: "UP",
  price: 0.5, executable: true, size: 1, fair: 0.5, diffusionGap: 0, tauMinutes: 10,
  logTau: Math.log1p(10), phase: 0.5, moneyness: 0, z: 0, sigmaRemaining: 0.01,
  sigmaPerMin: 0.001, distanceFromHalf: 0, ret1m: 0, ret5m: 0, ret15m: 0, volRatio: 1,
  priceChange: 0, secsSincePrevFill: 0, fillsBefore: 0, spotLagSec: 0,
  deltaPer1PctPerShare: 0, makerSide: "SELL_YES", won: 1, ret: 0.5, ...o,
});

/** `n` windows, each one row, quoted at `price`, of which `wins` settled true. */
const windows = (n: number, price: number, wins: number, tag = "w"): Observation[] =>
  Array.from({ length: n }, (_, i) =>
    obs({ marketId: `${tag}${i}`, at: 1000 + i, price, won: i < wins ? 1 : 0, ret: (i < wins ? 1 : 0) - price }),
  );

const bucketAt = (r: CalibrationReport, p: number) => r.buckets.find((b) => p >= b.lo && p < b.hi);

describe("bucket arithmetic", () => {
  it("puts a price in the bucket whose bounds contain it", () => {
    const r = calibrate(windows(100, 0.67, 67), { minWindows: 1 });
    const b = bucketAt(r, 0.67)!;
    expect([b.lo, b.hi]).toEqual([0.65, 0.7]);
    expect(b.quoted).toBeCloseTo(0.67, 10);
    expect(b.realized).toBeCloseTo(0.67, 10);
    expect(b.gap).toBeCloseTo(0, 10);
  });

  it("is left-inclusive and right-exclusive, except at the top", () => {
    // 0.70 belongs to 0.70–0.75, not to 0.65–0.70.
    const r = calibrate([...windows(40, 0.7, 28, "a"), ...windows(40, 0.699, 28, "b")], { minWindows: 1 });
    expect(r.buckets.find((b) => b.lo === 0.7)!.n).toBe(40);
    expect(r.buckets.find((b) => b.lo === 0.65)!.n).toBe(40);
  });

  it("keeps a probability of exactly 1 rather than dropping it off the end", () => {
    // The last bucket is inclusive on both sides, or certainty falls through it.
    const r = calibrate(windows(40, 1, 40), { minWindows: 1 });
    expect(r.n).toBe(40);
    expect(r.buckets.at(-1)!.hi).toBe(1);
    expect(r.buckets.at(-1)!.n).toBe(40);
  });

  it("handles the other boundary too", () => {
    const r = calibrate(windows(40, 0, 0), { minWindows: 1 });
    expect(r.buckets[0]!.lo).toBe(0);
    expect(r.buckets[0]!.n).toBe(40);
  });

  it("signs the gap so positive means the market was underconfident", () => {
    // Quoted 0.60, settled 0.75: the market hedged more than it needed to.
    const b = bucketAt(calibrate(windows(100, 0.6, 75), { minWindows: 1 }), 0.6)!;
    expect(b.gap).toBeGreaterThan(0);
    expect(b.realized).toBeCloseTo(0.75, 10);
  });

  it("returns an empty report rather than NaNs for no data", () => {
    const r = calibrate([]);
    expect(r.buckets).toEqual([]);
    expect(r.n).toBe(0);
    expect(Number.isFinite(r.brier)).toBe(true);
    expect(Number.isFinite(r.skill)).toBe(true);
  });

  it("skips buckets nothing landed in rather than emitting zeros", () => {
    const r = calibrate(windows(40, 0.67, 27), { minWindows: 1 });
    expect(r.buckets).toHaveLength(1);
  });
});

describe("correlated snapshots", () => {
  /** One window, forty fills, one outcome. */
  const oneWindowManyFills = Array.from({ length: 40 }, (_, i) =>
    obs({ marketId: "same", at: 1000 + i, price: 0.67, won: 1, ret: 0.33 }),
  );

  it("counts windows, not rows, as the independent unit", () => {
    const snap = calibrate(oneWindowManyFills, { basis: "snapshot", minWindows: 1 });
    expect(snap.n).toBe(40);
    expect(snap.windows).toBe(1);
    expect(bucketAt(snap, 0.67)!.windows).toBe(1);
  });

  it("collapses to one observation per window on the default basis", () => {
    const r = calibrate(oneWindowManyFills, { minWindows: 1 });
    expect(r.basis).toBe("window");
    expect(r.n).toBe(1);
  });

  it("reports a wider interval for one window than for forty", () => {
    // The whole point. Forty copies of one coin flip must not look like forty
    // coin flips, and the interval is where that shows up.
    const correlated = calibrate(oneWindowManyFills, { basis: "snapshot", minWindows: 1 });
    const independent = calibrate(windows(40, 0.67, 40), { basis: "snapshot", minWindows: 1 });
    expect(bucketAt(correlated, 0.67)!.se).toBeGreaterThanOrEqual(bucketAt(independent, 0.67)!.se);
  });

  it("does not always pick the earliest fill in a window", () => {
    // The first trade in a window is the most anomalous observation in this
    // venue's history, so "keep the first" would load every bucket with it.
    const picks = new Set<number>();
    for (let w = 0; w < 40; w++) {
      picks.add(onePerWindow([0, 1, 2, 3].map((i) => obs({ marketId: `w${w}`, at: i })))[0]!.at);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it("picks deterministically, so a published report reproduces", () => {
    const list = [0, 1, 2, 3, 4].map((i) => obs({ marketId: "fixed", at: i }));
    expect(onePerWindow(list)[0]!.at).toBe(onePerWindow([...list].reverse())[0]!.at);
  });
});

describe("thin samples", () => {
  it("marks a bucket thin below the window floor and leaves it visible", () => {
    // Hidden is worse than marked: a bucket that vanishes looks like no data,
    // and a bucket labelled thin looks like what it is.
    const r = calibrate(windows(4, 0.67, 4), { minWindows: 30 });
    const b = bucketAt(r, 0.67)!;
    expect(b.thin).toBe(true);
    expect(b.windows).toBe(4);
    expect(r.buckets).toContain(b);
  });

  it("does not mark a bucket thin once it clears the floor", () => {
    expect(bucketAt(calibrate(windows(30, 0.67, 20), { minWindows: 30 }), 0.67)!.thin).toBe(false);
  });
});

describe("skill", () => {
  it("is positive when the quoted probabilities beat the base rate", () => {
    const r = calibrate([...windows(50, 0.9, 45, "hi"), ...windows(50, 0.1, 5, "lo")], { minWindows: 1 });
    expect(r.brier).toBeLessThan(r.brierBase);
    expect(r.skill).toBeGreaterThan(0);
  });

  it("is about zero when every quote is the base rate", () => {
    const r = calibrate(windows(100, 0.5, 50), { minWindows: 1 });
    expect(Math.abs(r.skill)).toBeLessThan(1e-9);
  });
});

describe("assessment rules", () => {
  const base = { price: 0.67, bid: 0.66, ask: 0.68, depth: 50, reference: 0.66, historical: { realized: 0.66, windows: 200 } };

  it("names an insufficient sample before anything else", () => {
    // A caveat about the DATA outranks a claim about the price.
    expect(assess({ ...base, historical: { realized: 0.2, windows: 3 } }).code).toBe("INSUFFICIENT_SAMPLE");
    expect(assess({ ...base, historical: null }).code).toBe("INSUFFICIENT_SAMPLE");
  });

  it("names liquidity before spread, and spread before any price claim", () => {
    expect(assess({ ...base, depth: 1, ask: 0.99, bid: 0.1 }).code).toBe("LOW_LIQUIDITY");
    expect(assess({ ...base, ask: 0.9, bid: 0.4 }).code).toBe("HIGH_SPREAD");
  });

  it("calls a market overconfident when it quotes past what settled", () => {
    expect(assess({ ...base, historical: { realized: 0.55, windows: 200 } }).code).toBe("OVERCONFIDENT");
  });

  it("treats distance from a coin flip, not direction, as confidence", () => {
    // Quoting 0.20 and settling 0.30 is the same error as quoting 0.80 and
    // settling 0.70: both claimed more certainty than the outcomes supported.
    const low = assess({ ...base, price: 0.2, bid: 0.19, ask: 0.21, reference: 0.2, historical: { realized: 0.3, windows: 200 } });
    expect(low.code).toBe("OVERCONFIDENT");
  });

  it("calls it underconfident the other way", () => {
    expect(assess({ ...base, price: 0.8, bid: 0.79, ask: 0.81, reference: 0.8, historical: { realized: 0.9, windows: 200 } }).code).toBe("UNDERCONFIDENT");
  });

  it("says well calibrated when the gap is inside the tolerance", () => {
    expect(assess({ ...base, historical: { realized: 0.68, windows: 200 } }).code).toBe("WELL_CALIBRATED");
  });

  it("never returns a trading instruction", () => {
    const codes: AssessmentCode[] = [
      "INSUFFICIENT_SAMPLE", "LOW_LIQUIDITY", "HIGH_SPREAD",
      "LARGE_DISAGREEMENT", "OVERCONFIDENT", "UNDERCONFIDENT", "WELL_CALIBRATED",
    ];
    for (const c of codes) {
      expect(ASSESSMENT_LABEL[c]).toBeTruthy();
      expect(ASSESSMENT_TONE[c]).toBeTruthy();
      expect(ASSESSMENT_LABEL[c]).not.toMatch(/\b(buy|sell|long|short|edge|mispriced|guaranteed)\b/i);
    }
  });

  it("is deterministic — same inputs, same word", () => {
    for (let i = 0; i < 20; i++) expect(assess(base).code).toBe(assess(base).code);
  });

  it("keeps every threshold in one place", () => {
    expect(RULES.minWindows).toBeGreaterThanOrEqual(30);
    expect(RULES.calibrated).toBeGreaterThan(0);
    expect(DEFAULT_EDGES[0]).toBe(0);
    expect(DEFAULT_EDGES.at(-1)).toBe(1);
  });
});
