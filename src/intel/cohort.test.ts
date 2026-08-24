// Which comparable set answered, and whether it was allowed to.
//
// "Historical realized 61%" is worthless unless a reader can find out what 61%
// is the realized rate OF. The failure mode here is quiet: a lookup silently
// widens to a population that does not resemble the market on screen, and the
// number looks just as authoritative as one from the right cohort.

import { describe, expect, it } from "vitest";
import {
  calibrate, canonicalTenor, cohortChain, cohortKey, cohortLabel, cohortsOf,
  GLOBAL_COHORT, lookupCohort, sameCohort, type CalibrationReport,
} from "./calibration.js";
import type { Observation } from "../research/dataset.js";

const obs = (o: Partial<Observation> = {}): Observation => ({
  at: 1_000, marketId: "m1", asset: "BTC", intervalSec: 900, expiry: 2_000, leg: "UP",
  price: 0.5, executable: true, size: 1, fair: 0.5, diffusionGap: 0, tauMinutes: 10,
  logTau: 0, phase: 0.5, moneyness: 0, z: 0, sigmaRemaining: 0.01, sigmaPerMin: 0.001,
  distanceFromHalf: 0, ret1m: 0, ret5m: 0, ret15m: 0, volRatio: 1, priceChange: 0,
  secsSincePrevFill: 0, fillsBefore: 0, spotLagSec: 0, deltaPer1PctPerShare: 0,
  makerSide: "SELL_YES", won: 1, ret: 0.5, ...o,
});

/** `n` windows in one cohort, quoted at `price`, `wins` of which settled true. */
const windows = (n: number, price: number, wins: number, asset: string, iv: number, tag: string): Observation[] =>
  Array.from({ length: n }, (_, i) =>
    obs({ marketId: `${tag}${i}`, at: 1000 + i, asset: asset as Observation["asset"], intervalSec: iv, price, won: i < wins ? 1 : 0 }),
  );

const reportsFrom = (rows: Observation[]): Map<string, CalibrationReport> => {
  const out = new Map<string, CalibrationReport>();
  for (const [k, { rows: r }] of cohortsOf(rows)) out.set(k, calibrate(r, { basis: "window" }));
  return out;
};

describe("drifting tenors", () => {
  it("folds a window that drifted a second or two into its real series", () => {
    // The venue reports 898 and 900, 3598 and 3600, for one series. Keying on
    // the raw number split BTC 15m into a cohort of 300 windows and one of 2 —
    // which put usable buckets below the floor for no reason at all.
    expect(canonicalTenor(898)).toBe(900);
    expect(canonicalTenor(900)).toBe(900);
    expect(canonicalTenor(3598)).toBe(3600);
    expect(canonicalTenor(14_401)).toBe(14_400);
  });

  it("leaves a genuinely unknown cadence alone", () => {
    expect(canonicalTenor(7_777)).toBe(7_777);
  });

  it("puts drifted rows in one cohort rather than two", () => {
    const rows = [...windows(20, 0.5, 10, "BTC", 900, "a"), ...windows(20, 0.5, 10, "BTC", 898, "b")];
    const cohorts = cohortsOf(rows);
    expect(cohorts.get(cohortKey({ asset: "BTC", intervalSec: 900 }))!.rows).toHaveLength(40);
    expect(cohorts.has(cohortKey({ asset: "BTC", intervalSec: 898 }))).toBe(false);
  });
});

describe("the fallback chain", () => {
  it("goes specific, then asset, then tenor, then global", () => {
    expect(cohortChain("BTC", 900)).toEqual([
      { asset: "BTC", intervalSec: 900 },
      { asset: "BTC", intervalSec: null },
      { asset: null, intervalSec: 900 },
      GLOBAL_COHORT,
    ]);
  });

  it("prefers the tenor cohort over the global one", () => {
    // A 15-minute contract on either underlying is closer to another 15-minute
    // contract than it is to a daily one: what moves a calibration curve most is
    // how much can happen before settlement.
    const chain = cohortChain("BTC", 900);
    expect(chain.indexOf(chain.find((c) => c.asset === null && c.intervalSec === 900)!))
      .toBeLessThan(chain.indexOf(GLOBAL_COHORT));
  });

  it("answers from the most specific cohort when it has the sample", () => {
    // BTC 15m thick enough to stand on its own.
    const rows = [...windows(60, 0.67, 40, "BTC", 900, "btc"), ...windows(60, 0.67, 10, "ETH", 900, "eth")];
    const hit = lookupCohort(reportsFrom(rows), "BTC", 900, 0.67);
    expect(hit.cohort).toEqual({ asset: "BTC", intervalSec: 900 });
    expect(hit.fellBack).toBe(false);
    // And it is BTC's number, not the pooled one.
    expect(hit.bucket!.realized).toBeCloseTo(40 / 60, 6);
  });

  it("widens only when the specific cohort is too thin, and says so", () => {
    // BTC 15m has four windows; the pooled 15m cohort has plenty.
    const rows = [...windows(4, 0.67, 3, "BTC", 900, "btc"), ...windows(80, 0.67, 40, "ETH", 900, "eth")];
    const hit = lookupCohort(reportsFrom(rows), "BTC", 900, 0.67);
    expect(hit.fellBack).toBe(true);
    expect(hit.bucket!.thin).toBe(false);
    expect(hit.bucket!.windows).toBeGreaterThanOrEqual(30);
  });

  it("returns the thin answer rather than nothing when everything is thin", () => {
    // "We looked and the sample is small" is information. Silence is not.
    const rows = windows(4, 0.67, 3, "BTC", 900, "btc");
    const hit = lookupCohort(reportsFrom(rows), "BTC", 900, 0.67);
    expect(hit.bucket).not.toBeNull();
    expect(hit.bucket!.thin).toBe(true);
    expect(hit.cohort).toEqual({ asset: "BTC", intervalSec: 900 });
  });

  it("returns nothing when no cohort covers the price at all", () => {
    const hit = lookupCohort(reportsFrom(windows(60, 0.1, 6, "BTC", 900, "b")), "BTC", 900, 0.9);
    expect(hit.bucket).toBeNull();
  });

  it("survives an empty store", () => {
    const hit = lookupCohort(new Map(), "BTC", 900, 0.67);
    expect(hit.bucket).toBeNull();
    expect(hit.cohort).toEqual({ asset: "BTC", intervalSec: 900 });
  });

  it("never silently answers from a cohort it does not report", () => {
    // The whole contract: whatever comes back, the caller is told which
    // population produced it.
    const rows = [...windows(4, 0.67, 3, "BTC", 900, "b"), ...windows(80, 0.67, 40, "ETH", 900, "e")];
    const hit = lookupCohort(reportsFrom(rows), "BTC", 900, 0.67);
    expect(cohortChain("BTC", 900).some((c) => sameCohort(c, hit.cohort))).toBe(true);
    expect(cohortLabel(hit.cohort)).toBeTruthy();
  });
});

describe("cohort labels", () => {
  it("names each shape in words a reader can check", () => {
    expect(cohortLabel({ asset: "BTC", intervalSec: 900 })).toBe("BTC 15m");
    expect(cohortLabel({ asset: "ETH", intervalSec: 3600 })).toBe("ETH 1h");
    expect(cohortLabel({ asset: "BTC", intervalSec: 86_400 })).toBe("BTC 1d");
    expect(cohortLabel({ asset: "BTC", intervalSec: null })).toBe("BTC, all tenors");
    expect(cohortLabel({ asset: null, intervalSec: 900 })).toBe("all assets, 15m");
    expect(cohortLabel(GLOBAL_COHORT)).toBe("all assets and tenors");
  });

  it("keys cohorts distinctly, including the nulls", () => {
    const keys = [
      { asset: "BTC", intervalSec: 900 }, { asset: "BTC", intervalSec: null },
      { asset: null, intervalSec: 900 }, GLOBAL_COHORT,
    ].map(cohortKey);
    expect(new Set(keys).size).toBe(4);
  });
});

describe("splitting rows into cohorts", () => {
  it("files one row under its own cohort and every parent", () => {
    const c = cohortsOf([obs({ asset: "BTC", intervalSec: 900 })]);
    expect(c.get(cohortKey({ asset: "BTC", intervalSec: 900 }))!.rows).toHaveLength(1);
    expect(c.get(cohortKey({ asset: "BTC", intervalSec: null }))!.rows).toHaveLength(1);
    expect(c.get(cohortKey({ asset: null, intervalSec: 900 }))!.rows).toHaveLength(1);
    expect(c.get(cohortKey(GLOBAL_COHORT))!.rows).toHaveLength(1);
  });

  it("keeps the global cohort the largest", () => {
    const rows = [...windows(10, 0.5, 5, "BTC", 900, "a"), ...windows(10, 0.5, 5, "ETH", 3600, "b")];
    const c = cohortsOf(rows);
    const global = c.get(cohortKey(GLOBAL_COHORT))!.rows.length;
    for (const [, v] of c) expect(v.rows.length).toBeLessThanOrEqual(global);
    expect(global).toBe(20);
  });
});
