// The fair-value model is the thing the whole submission rests on. Its inputs are
// three numbers and its output is a probability, which makes it easy to get
// subtly wrong in a way that still looks plausible on a dashboard.

import { describe, expect, it } from "vitest";
import { BASE_RATE_UP, clampProbability, fairValue, normalCdf, shrink } from "./fairvalue.js";
import { sigmaOverHorizon, sigmaPerMinute, MIN_SIGMA_PER_MIN, type Bar } from "./vol.js";

describe("normalCdf", () => {
  it("matches known values of the standard normal", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 5);
    expect(normalCdf(-2.5758)).toBeCloseTo(0.005, 4);
  });

  it("is symmetric about zero", () => {
    for (const z of [0.3, 1.1, 2.7, 4]) expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 6);
  });

  it("saturates without overflowing at the tails", () => {
    expect(normalCdf(40)).toBeCloseTo(1, 10);
    expect(normalCdf(-40)).toBeCloseTo(0, 10);
  });
});

describe("fairValue", () => {
  const base = { spot: 100, reference: 100, sigmaPerMin: 0.001, tauMinutes: 60 };

  it("is a coin flip when spot sits exactly on the reference", () => {
    // This is the ONLY situation in which 50/50 is the right answer, and the one
    // that makes the unconditional base rate a tempting mistake elsewhere.
    //
    // Asserted to six places, not more: normalCdf uses the Abramowitz & Stegun
    // approximation whose documented worst-case error is 1.5e-7. Demanding
    // tighter than the method guarantees makes a passing test a coincidence.
    expect(fairValue(base)!.pUp).toBeCloseTo(0.5, 6);
  });

  it("rises above 0.5 when spot is above the reference, and falls below when under", () => {
    expect(fairValue({ ...base, spot: 101 })!.pUp).toBeGreaterThan(0.5);
    expect(fairValue({ ...base, spot: 99 })!.pUp).toBeLessThan(0.5);
  });

  it("converges toward certainty as time runs out", () => {
    // A window nearly over, with spot already clear of its reference, is not a
    // coin flip — it is nearly decided. Getting this wrong is what makes a
    // correctly-priced 0.97 book look like a 47-point mispricing.
    const far = fairValue({ ...base, spot: 101, tauMinutes: 600 })!.pUp;
    const near = fairValue({ ...base, spot: 101, tauMinutes: 1 })!.pUp;
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(0.99);
  });

  it("pulls back toward 0.5 as volatility grows, at fixed moneyness", () => {
    const calm = fairValue({ ...base, spot: 101, sigmaPerMin: 0.0005 })!.pUp;
    const wild = fairValue({ ...base, spot: 101, sigmaPerMin: 0.01 })!.pUp;
    expect(calm).toBeGreaterThan(wild);
    expect(wild).toBeGreaterThan(0.5);
  });

  it("scales volatility with the square root of time, not linearly", () => {
    // Diffusive, so a one-minute measurement cannot dominate a long-dated window.
    const fv = fairValue({ ...base, tauMinutes: 100 })!;
    expect(fv.sigmaRemaining).toBeCloseTo(0.001 * 10, 10);
  });

  it("reports moneyness as a log ratio, so the two legs are exact complements", () => {
    const up = fairValue({ ...base, spot: 105 })!;
    const down = fairValue({ ...base, spot: 100 / 1.05 })!;
    expect(up.moneyness).toBeCloseTo(-down.moneyness, 10);
    expect(up.pUp + down.pUp).toBeCloseTo(1, 10);
  });

  it("refuses impossible inputs rather than returning a confident number", () => {
    expect(fairValue({ ...base, spot: 0 })).toBeNull();
    expect(fairValue({ ...base, reference: 0 })).toBeNull();
    expect(fairValue({ ...base, sigmaPerMin: 0 })).toBeNull();
    expect(fairValue({ ...base, spot: Number.NaN })).toBeNull();
  });
});

describe("shrink", () => {
  it("leaves the model alone at slope 1", () => {
    expect(shrink(0.8, 1)).toBeCloseTo(0.8, 10);
  });

  it("collapses to the prior at slope 0", () => {
    expect(shrink(0.95, 0)).toBeCloseTo(BASE_RATE_UP, 10);
  });

  it("moves halfway at slope 0.5", () => {
    expect(shrink(0.9, 0.5)).toBeCloseTo(BASE_RATE_UP + 0.5 * (0.9 - BASE_RATE_UP), 10);
  });

  it("clamps a slope outside [0,1] rather than amplifying the model", () => {
    expect(shrink(0.9, 5)).toBeCloseTo(shrink(0.9, 1), 10);
    expect(shrink(0.9, -2)).toBeCloseTo(BASE_RATE_UP, 10);
  });
});

describe("clampProbability", () => {
  it("keeps probabilities strictly inside (0,1) so Kelly stays finite", () => {
    expect(clampProbability(0)).toBeGreaterThan(0);
    expect(clampProbability(1)).toBeLessThan(1);
    expect(clampProbability(0.5)).toBe(0.5);
  });
});

describe("sigmaPerMinute", () => {
  const bars = (closes: number[]): Bar[] => closes.map((close, i) => ({ t: i * 60, close }));

  it("returns null rather than guessing when there is too little history", () => {
    // A fabricated sigma produces a confident, wrong probability — the caller has
    // to be able to tell "no estimate" from "low volatility".
    expect(sigmaPerMinute(bars([100, 101, 102]), 2, 100)).toBeNull();
  });

  it("measures a constant proportional move as that move", () => {
    const closes = [100];
    for (let i = 0; i < 60; i++) closes.push(closes[closes.length - 1]! * (i % 2 === 0 ? 1.01 : 1 / 1.01));
    const s = sigmaPerMinute(bars(closes), closes.length - 1, 200)!;
    expect(s).toBeCloseTo(Math.log(1.01), 3);
  });

  it("floors a flat feed rather than reporting certainty", () => {
    // A stalled price feed measures as zero volatility, which would price every
    // window at 0 or 1.
    const flat = bars(new Array(100).fill(100));
    expect(sigmaPerMinute(flat, 99, 200)).toBe(MIN_SIGMA_PER_MIN);
  });

  it("only looks backwards from the given index", () => {
    const calmThenWild = bars([...new Array(60).fill(100), ...[100, 200, 100, 200, 100]]);
    const early = sigmaPerMinute(calmThenWild, 59, 200)!;
    expect(early).toBe(MIN_SIGMA_PER_MIN); // the wild part is in the future
  });
});

describe("sigmaOverHorizon", () => {
  it("grows with the square root of the horizon", () => {
    expect(sigmaOverHorizon(0.01, 4)).toBeCloseTo(0.02, 10);
    expect(sigmaOverHorizon(0.01, 100)).toBeCloseTo(0.1, 10);
  });

  it("stays positive for a sub-second horizon so z never divides by zero", () => {
    expect(sigmaOverHorizon(0.01, 0)).toBeGreaterThan(0);
  });
});
