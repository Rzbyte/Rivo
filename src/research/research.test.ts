// Tests for the alpha research plumbing.
//
// The subject here is not a trading result — it is the machinery that decides
// whether a trading result may be believed, and every case below is a mistake
// this study actually made before it was caught.

import { describe, expect, it } from "vitest";
import { executableLeg, featureVector, FEATURES, type Observation } from "./dataset.js";
import { economics, oncePerWindow, walkForward, edgeBuckets, type Trade, type Strategy } from "./walkforward.js";
import { fitRidge, predict } from "./residual.js";
import { judge, mayExecuteLive, DEFAULT_ACCEPTANCE, type FoldEconomics } from "./gating.js";

const obs = (o: Partial<Observation> = {}): Observation => ({
  at: 1_000, marketId: "m1", asset: "BTC", intervalSec: 900, expiry: 2_000, leg: "UP",
  price: 0.5, executable: true, size: 1, fair: 0.5, diffusionGap: 0, tauMinutes: 10,
  logTau: Math.log1p(10), phase: 0.5, moneyness: 0, z: 0, sigmaRemaining: 0.01,
  sigmaPerMin: 0.001, distanceFromHalf: 0, ret1m: 0, ret5m: 0, ret15m: 0, volRatio: 1,
  priceChange: 0, secsSincePrevFill: 0, fillsBefore: 0, spotLagSec: 0,
  deltaPer1PctPerShare: 0, makerSide: "SELL_YES", won: 1, ret: 0.5, ...o,
});

const trade = (o: Partial<Trade> = {}): Trade => ({
  at: 1_000, marketId: "m1", asset: "BTC", intervalSec: 900, leg: "UP",
  price: 0.5, edge: 0.02, ret: 0.5, won: 1, fold: 1, ...o,
});

describe("executable side", () => {
  it("maps a resting order to the side a taker could actually hit", () => {
    // A resting SELL_YES is liquidity to BUY yes; a resting BUY_YES is liquidity
    // to sell it, which is buying the DOWN leg.
    expect(executableLeg("SELL_YES")).toBe("UP");
    expect(executableLeg("BUY_YES")).toBe("DOWN");
  });

  it("refuses to guess when the side is unrecognised", () => {
    // Guessing here would silently license trades that were never available.
    expect(executableLeg("")).toBeNull();
    expect(executableLeg("SOMETHING_ELSE")).toBeNull();
  });
});

describe("feature vector", () => {
  it("has one entry per declared feature name", () => {
    expect(featureVector(obs())).toHaveLength(FEATURES.length);
  });

  it("contains nothing derived from the outcome", () => {
    // The whole study is worthless if `won` reaches a feature. Two rows that
    // differ ONLY in how they settled must be indistinguishable to the model.
    const a = featureVector(obs({ won: 1, ret: 0.5 }));
    const b = featureVector(obs({ won: 0, ret: -0.5 }));
    expect(a).toEqual(b);
  });

  it("centres price so the intercept means something", () => {
    const i = FEATURES.indexOf("priceCentred");
    expect(featureVector(obs({ price: 0.5 }))[i]).toBe(0);
    expect(featureVector(obs({ price: 0.9 }))[i]).toBeCloseTo(0.4, 10);
  });
});

describe("economics", () => {
  it("reports return on stake, not return on notional", () => {
    // Two shares at 0.25 returning 1 each: staked 0.5, made 1.5.
    const e = economics([trade({ price: 0.25, ret: 0.75, marketId: "a" }), trade({ price: 0.25, ret: 0.75, marketId: "b" })]);
    expect(e.stake).toBeCloseTo(0.5, 10);
    expect(e.pnl).toBeCloseTo(1.5, 10);
    expect(e.returnOnStake).toBeCloseTo(3, 10);
  });

  it("clusters its standard error on the settled window", () => {
    // Forty fills from one window are one coin flip. An error bar that treats
    // them as forty observations is the single easiest way to publish noise.
    const oneWindow = Array.from({ length: 40 }, (_, i) => trade({ at: 1000 + i, marketId: "same", ret: 0.5 }));
    const forty = Array.from({ length: 40 }, (_, i) => trade({ at: 1000 + i, marketId: `w${i}`, ret: 0.5 }));
    expect(economics(oneWindow).windows).toBe(1);
    expect(economics(forty).windows).toBe(40);
  });

  it("measures drawdown along the time path, not the input order", () => {
    const e = economics([
      trade({ at: 3, marketId: "c", ret: +1 }),
      trade({ at: 1, marketId: "a", ret: +1 }),
      trade({ at: 2, marketId: "b", ret: -2 }),
    ]);
    expect(e.maxDrawdown).toBeCloseTo(2, 10);
  });

  it("is empty rather than NaN with no trades", () => {
    const e = economics([]);
    expect(e.trades).toBe(0);
    expect(e.returnOnStake).toBe(0);
    expect(Number.isFinite(e.tStat)).toBe(true);
  });
});

describe("oncePerWindow", () => {
  it("keeps exactly one entry per window", () => {
    const many = [
      trade({ marketId: "a", at: 1 }), trade({ marketId: "a", at: 2 }), trade({ marketId: "a", at: 3 }),
      trade({ marketId: "b", at: 4 }), trade({ marketId: "b", at: 5 }),
    ];
    const once = oncePerWindow(many);
    expect(once).toHaveLength(2);
    expect(new Set(once.map((t) => t.marketId))).toEqual(new Set(["a", "b"]));
  });

  it("does not always pick the earliest", () => {
    // The bug this replaced. The first fill in a window is the most anomalous
    // observation in the sample, so "keep the first" loaded every strategy with
    // that anomaly and called the result decorrelation.
    const picks = new Set<number>();
    for (let w = 0; w < 40; w++) {
      const list = [0, 1, 2, 3].map((i) => trade({ marketId: `w${w}`, at: i }));
      picks.add(oncePerWindow(list)[0]!.at);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it("is deterministic, so the artefact reproduces", () => {
    const list = [0, 1, 2, 3, 4].map((i) => trade({ marketId: "fixed", at: i }));
    expect(oncePerWindow(list)[0]!.at).toBe(oncePerWindow(list)[0]!.at);
    expect(oncePerWindow([...list].reverse())[0]!.at).toBe(oncePerWindow(list)[0]!.at);
  });
});

describe("walk-forward", () => {
  /** Rows across many windows, settling in order. */
  const sample = (): Observation[] => {
    const rows: Observation[] = [];
    for (let w = 0; w < 60; w++) {
      for (let f = 0; f < 3; f++) {
        rows.push(obs({
          marketId: `w${w}`, at: w * 100 + f, expiry: w * 100 + 50,
          won: w % 2 === 0 ? 1 : 0, ret: w % 2 === 0 ? 0.5 : -0.5,
        }));
      }
    }
    return rows;
  };

  it("never trains on a window that had not settled when the fold opened", () => {
    // Settlement leakage: the half a shuffled split hides completely.
    const rows = sample();
    // The newest settlement each fit() was shown, in fit order.
    const newestSeen: number[] = [];
    const spy: Strategy = {
      name: "spy",
      fit(train) {
        newestSeen.push(Math.max(...train.map((r) => r.expiry)));
      },
      decide: () => ({ edge: 0, trade: false }),
    };
    const res = walkForward(rows, spy, { folds: 4, minTrain: 1 });
    expect(res.folds.length).toBeGreaterThan(0);
    expect(newestSeen).toHaveLength(res.folds.length);
    res.folds.forEach((f, i) => {
      expect(newestSeen[i]!).toBeLessThanOrEqual(f.fold.testStart);
    });
  });

  it("gives every fold a comparable number of settled windows", () => {
    // Equal-time folds put 95% of the recorded history in the training block and
    // scored the candidates on the remainder.
    const rows = sample();
    const res = walkForward(rows, { name: "all", decide: () => ({ edge: 1, trade: true }) }, { folds: 4, minTrain: 1 });
    const counts = res.folds.map((f) => new Set(rows.filter((r) => r.at >= f.fold.testStart && r.at < f.fold.testEnd).map((r) => r.marketId)).size);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("returns nothing rather than something when there is no data", () => {
    const res = walkForward([], { name: "x", decide: () => ({ edge: 0, trade: true }) });
    expect(res.all.trades).toBe(0);
    expect(res.folds).toEqual([]);
  });
});

describe("edge buckets", () => {
  it("shows whether a bigger claim actually paid better", () => {
    const b = edgeBuckets([
      trade({ marketId: "a", edge: 0.005, ret: 0.1 }),
      trade({ marketId: "b", edge: 0.06, ret: -0.1 }),
    ]);
    expect(b).toHaveLength(2);
    expect(b[0]!.returnOnStake).toBeGreaterThan(0);
    expect(b[1]!.returnOnStake).toBeLessThan(0);
  });
});

describe("ridge", () => {
  it("recovers a linear relationship it was shown", () => {
    const X: number[][] = [];
    const y: number[] = [];
    const c: string[] = [];
    for (let i = 0; i < 400; i++) {
      const x = (i % 40) / 40 - 0.5;
      X.push([x, ((i * 7) % 13) / 13 - 0.5]);
      y.push(0.25 * x + 0.01);
      c.push(`w${i % 80}`);
    }
    const m = fitRidge(X, y, c, { lambda: 1e-8, bootstrap: 4 });
    expect(m).not.toBeNull();
    const hi = predict(m!, [0.5, 0]).mu;
    const lo = predict(m!, [-0.5, 0]).mu;
    expect(hi - lo).toBeGreaterThan(0.2);
  });

  it("refuses to fit fewer rows than it has parameters", () => {
    expect(fitRidge([[1, 2, 3]], [0.5], ["w"], {})).toBeNull();
  });

  it("widens its interval when the clusters disagree", () => {
    const mk = (spread: number) => {
      const X: number[][] = [], y: number[] = [], c: string[] = [];
      for (let w = 0; w < 40; w++) {
        const shift = (w % 2 === 0 ? 1 : -1) * spread;
        for (let i = 0; i < 5; i++) { X.push([(i - 2) / 2]); y.push(shift); c.push(`w${w}`); }
      }
      return fitRidge(X, y, c, { lambda: 1e-6, bootstrap: 32 })!;
    };
    expect(predict(mk(0.4), [0]).sd).toBeGreaterThan(predict(mk(0.01), [0]).sd);
  });
});

describe("the acceptance gate", () => {
  const good = { ...economics([]), trades: 900, windows: 400, stake: 400, pnl: 24, returnOnStake: 0.06, tStat: 3.1, maxDrawdown: 20 };
  const folds: FoldEconomics[] = [1, 2, 3, 4].map((i) => ({
    fold: i, economics: { ...economics([]), stake: 100, pnl: 6, returnOnStake: 0.06, windows: 100 },
  }));
  const base = { ...economics([]), returnOnStake: 0.0, stake: 1, pnl: 0 };

  it("passes only when nothing is outstanding", () => {
    const v = judge(good, folds, base);
    expect(v.failures).toEqual([]);
    expect(v.state).toBe("VALIDATED");
    expect(mayExecuteLive(v.state)).toBe(true);
  });

  it("rejects a result that lives in one fold", () => {
    // The criterion the strongest candidate in the study failed.
    const lumpy: FoldEconomics[] = [
      { fold: 1, economics: { ...economics([]), stake: 100, pnl: -1, returnOnStake: -0.01, windows: 100 } },
      { fold: 2, economics: { ...economics([]), stake: 100, pnl: 0, returnOnStake: 0, windows: 100 } },
      { fold: 3, economics: { ...economics([]), stake: 100, pnl: 1, returnOnStake: 0.01, windows: 100 } },
      { fold: 4, economics: { ...economics([]), stake: 100, pnl: 24, returnOnStake: 0.24, windows: 100 } },
    ];
    const v = judge(good, lumpy, base);
    expect(v.state).toBe("REJECTED");
    expect(v.failures.join(" ")).toMatch(/removing the best fold/);
    expect(v.withoutBestFold!.returnOnStake).toBeLessThan(0.02);
  });

  it("rejects a candidate that merely matches the base rate", () => {
    const v = judge(good, folds, { ...base, returnOnStake: 0.07 });
    expect(v.state).toBe("REJECTED");
    expect(v.failures.join(" ")).toMatch(/does not beat taking every available fill/);
  });

  it("does not ask the base rate to beat itself", () => {
    const v = judge(good, folds, good);
    expect(v.failures.join(" ")).not.toMatch(/does not beat/);
  });

  it("rejects a strong-looking result from too few windows", () => {
    const v = judge({ ...good, windows: 40 }, folds, base);
    expect(v.state).toBe("REJECTED");
    expect(v.failures.join(" ")).toMatch(/below the 200 required/);
  });

  it("will not validate without a base-rate comparison", () => {
    const v = judge(good, folds, null);
    expect(v.state).toBe("REJECTED");
    expect(v.failures.join(" ")).toMatch(/no base-rate comparison/);
  });

  it("treats an unevaluated candidate as UNVALIDATED, not as passing", () => {
    const v = judge(good, [], base);
    expect(v.state).toBe("UNVALIDATED");
    expect(mayExecuteLive(v.state)).toBe(false);
  });

  it("lets only VALIDATED spend money", () => {
    expect(mayExecuteLive("VALIDATED")).toBe(true);
    for (const s of ["UNVALIDATED", "SHADOW_ONLY", "REJECTED"] as const) expect(mayExecuteLive(s)).toBe(false);
  });

  it("keeps the published floor where the brief put it", () => {
    expect(DEFAULT_ACCEPTANCE.minTStat).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_ACCEPTANCE.survivesBestFoldRemoval).toBe(true);
    expect(DEFAULT_ACCEPTANCE.mustBeatBaseRate).toBe(true);
  });
});
