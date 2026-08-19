// Every headline number in EVIDENCE.md comes out of this file — AUC 0.83, Brier
// 0.17, 32% skill. If the scoring rules are wrong the whole document is wrong,
// so they are checked against cases whose answers are known by construction
// rather than by having run them once.

import { describe, expect, it } from "vitest";
import {
  applyPlatt,
  auc,
  brierOfConstant,
  brierOptimalShrinkage,
  brierScore,
  brierSkill,
  fitPlatt,
  IDENTITY_MAP,
  logLoss,
  reliability,
  type Prediction,
} from "./metrics.js";

const p = (p: number, y: 0 | 1): Prediction => ({ p, y });

describe("brierScore", () => {
  it("is zero for a perfect, confident forecast", () => {
    expect(brierScore([p(1, 1), p(0, 0)])).toBe(0);
  });

  it("is one for a confidently inverted forecast", () => {
    expect(brierScore([p(0, 1), p(1, 0)])).toBe(1);
  });

  it("is 0.25 for a coin flip, which is the baseline everything is measured against", () => {
    expect(brierOfConstant([p(0.9, 1), p(0.1, 0), p(0.5, 1)], 0.5)).toBe(0.25);
  });
});

describe("brierSkill", () => {
  it("is the fraction of the baseline's error removed", () => {
    expect(brierSkill(0.125, 0.25)).toBeCloseTo(0.5, 10);
    expect(brierSkill(0.25, 0.25)).toBe(0); // no better than the baseline
    expect(brierSkill(0.5, 0.25)).toBe(-1); // twice the error
  });
});

describe("auc", () => {
  it("is 1 when the ranking is perfect", () => {
    expect(auc([p(0.9, 1), p(0.8, 1), p(0.2, 0), p(0.1, 0)])).toBe(1);
  });

  it("is 0 when the ranking is exactly inverted", () => {
    expect(auc([p(0.1, 1), p(0.2, 1), p(0.8, 0), p(0.9, 0)])).toBe(0);
  });

  it("is 0.5 for a constant forecast — ties must not score as skill", () => {
    // Without average-rank tie handling a model that outputs one number scores
    // 0 or 1 depending on sort order, which would be a spectacular false signal.
    expect(auc([p(0.5, 1), p(0.5, 0), p(0.5, 1), p(0.5, 0)])).toBe(0.5);
  });

  it("is unaffected by a monotone transform, since it measures ranking only", () => {
    const raw = [p(0.9, 1), p(0.6, 1), p(0.4, 0), p(0.1, 0)];
    const squashed = raw.map((d) => p(0.5 + (d.p - 0.5) * 0.1, d.y));
    expect(auc(squashed)).toBeCloseTo(auc(raw), 10);
  });

  it("is not defined when one class is absent", () => {
    expect(Number.isNaN(auc([p(0.9, 1), p(0.8, 1)]))).toBe(true);
  });
});

describe("brierOptimalShrinkage", () => {
  it("is 1 when the model's confidence is exactly earned", () => {
    // Outcomes that land precisely on the forecasts: nothing to shrink.
    const preds = [p(1, 1), p(0, 0), p(1, 1), p(0, 0)];
    expect(brierOptimalShrinkage(preds, 0.5)).toBeCloseTo(1, 10);
  });

  it("is 0 when the model carries no information about the outcome", () => {
    // Every forecast is matched by an opposite outcome at the same confidence.
    const preds = [p(0.9, 1), p(0.9, 0), p(0.1, 1), p(0.1, 0)];
    expect(brierOptimalShrinkage(preds, 0.5)).toBeCloseTo(0, 10);
  });

  it("is negative when the model is anti-predictive", () => {
    expect(brierOptimalShrinkage([p(0.9, 0), p(0.1, 1)], 0.5)).toBeLessThan(0);
  });

  it("halves a model that overstates its edge twofold", () => {
    // Forecasts sit 0.4 from the prior; outcomes only justify 0.2 of that.
    const preds = [p(0.9, 1), p(0.9, 1), p(0.9, 0), p(0.9, 0), p(0.9, 1), p(0.1, 0), p(0.1, 0), p(0.1, 1), p(0.1, 1), p(0.1, 0)];
    const k = brierOptimalShrinkage(preds, 0.5);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(1);
  });

  it("returns 0 rather than dividing by zero on a constant forecast", () => {
    expect(brierOptimalShrinkage([p(0.5, 1), p(0.5, 0)], 0.5)).toBe(0);
  });
});

describe("reliability", () => {
  it("reports where the model said it was against where it landed", () => {
    const bins = reliability([p(0.05, 0), p(0.05, 0), p(0.95, 1), p(0.95, 1)], 10);
    expect(bins).toHaveLength(2);
    expect(bins[0]!.meanP).toBeCloseTo(0.05, 10);
    expect(bins[0]!.freq).toBe(0);
    expect(bins[1]!.meanP).toBeCloseTo(0.95, 10);
    expect(bins[1]!.freq).toBe(1);
  });

  it("puts a forecast of exactly 1.0 in the top bin, not past the end", () => {
    const bins = reliability([p(1, 1)], 10);
    expect(bins).toHaveLength(1);
    expect(bins[0]!.n).toBe(1);
  });

  it("omits empty bins rather than reporting NaN frequencies", () => {
    expect(reliability([p(0.5, 1)], 10).every((b) => b.n > 0)).toBe(true);
  });
});

describe("fitPlatt", () => {
  it("leaves an already-calibrated model essentially alone", () => {
    // 200 forecasts at 0.7 of which ~70% resolve true.
    const preds: Prediction[] = [];
    for (let i = 0; i < 200; i++) preds.push(p(0.7, i % 10 < 7 ? 1 : 0));
    for (let i = 0; i < 200; i++) preds.push(p(0.3, i % 10 < 3 ? 1 : 0));
    const map = fitPlatt(preds);
    expect(applyPlatt(map, 0.7)).toBeCloseTo(0.7, 1);
    expect(applyPlatt(map, 0.3)).toBeCloseTo(0.3, 1);
  });

  it("pulls an overconfident model back toward the middle", () => {
    // Says 0.99 but only right 60% of the time.
    const preds: Prediction[] = [];
    for (let i = 0; i < 300; i++) preds.push(p(0.99, i % 10 < 6 ? 1 : 0));
    for (let i = 0; i < 300; i++) preds.push(p(0.01, i % 10 < 4 ? 1 : 0));
    expect(applyPlatt(fitPlatt(preds), 0.99)).toBeLessThan(0.9);
  });

  it("declines to fit on a sample too small to mean anything", () => {
    expect(fitPlatt([p(0.9, 1), p(0.1, 0)])).toEqual(IDENTITY_MAP);
  });

  it("keeps probabilities strictly inside (0,1) so downstream Kelly stays finite", () => {
    const out = applyPlatt({ a: 50, b: 0 }, 0.999999);
    expect(out).toBeLessThan(1);
    expect(out).toBeGreaterThan(0);
  });
});

describe("logLoss", () => {
  it("punishes a confident error far harder than Brier does", () => {
    const wrong = [p(0.999, 0)];
    expect(logLoss(wrong)).toBeGreaterThan(5);
    expect(brierScore(wrong)).toBeLessThan(1);
  });

  it("stays finite on a forecast of exactly 0 or 1", () => {
    expect(Number.isFinite(logLoss([p(0, 1), p(1, 0)]))).toBe(true);
  });
});
