// The conditional fair value of an Event Contract.
//
// The question every live window asks is "does X close at or above its OPENING
// price". That has a 50/50 answer only at inception. Once the window is running,
// the honest probability conditions on where spot sits relative to the reference
// and on how much time is left to move back:
//
//     P(close >= reference) = Phi( ln(S/R) / (sigma * sqrt(tau)) )
//
// Comparing a live book against the unconditional 50% base rate instead is a
// category error: it makes a correctly-priced deep-in-the-money window at 0.97
// look like a 47-point mispricing. The base rate belongs in exactly two places
// — as the prior for a window with no path yet, and as the anchor a calibration
// study measures against.

import { sigmaOverHorizon } from "./vol.js";

/** Standard normal CDF, via the error function. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Abramowitz & Stegun 7.1.26 — max error 1.5e-7, far below our model error. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export interface FairValueInput {
  /** Current underlying price. */
  spot: number;
  /** The level the contract settles against — its resolved opening price. */
  reference: number;
  /** Measured per-minute log-return standard deviation of the underlying. */
  sigmaPerMin: number;
  /** Minutes until the window expires. */
  tauMinutes: number;
}

export interface FairValue {
  /** P(UP wins) — the probability the Up leg pays 1. */
  pUp: number;
  /** Log-moneyness: how far spot sits above (+) or below (-) the reference. */
  moneyness: number;
  /** Volatility over the remaining life, in the same log units as moneyness. */
  sigmaRemaining: number;
  /** Standardised distance to the reference. */
  z: number;
}

/**
 * Price one window from the underlying.
 *
 * Driftless: over minutes to hours the drift term is far below the noise, and
 * assuming one would only encode a directional view the model has no basis for.
 */
export function fairValue(input: FairValueInput): FairValue | null {
  const { spot, reference, sigmaPerMin, tauMinutes } = input;
  if (!(spot > 0) || !(reference > 0) || !(sigmaPerMin > 0)) return null;
  const moneyness = Math.log(spot / reference);
  const sigmaRemaining = sigmaOverHorizon(sigmaPerMin, tauMinutes);
  if (!(sigmaRemaining > 0)) return null;
  const z = moneyness / sigmaRemaining;
  return { pUp: normalCdf(z), moneyness, sigmaRemaining, z };
}

/**
 * The measured at-inception base rate of these markets: 50.23% UP over 2,982
 * settled windows (testnet, 2026-07-20 -> 07-31). It is the prior a fresh window
 * deserves before it has any path, and the baseline any model must beat.
 */
export const BASE_RATE_UP = 0.5023;

/**
 * Shrink a model probability toward the prior.
 *
 * Kelly sizing on an uncalibrated probability is a ruin machine: the fraction it
 * asks for scales with an edge the model has not earned. `slope` comes from the
 * calibration study — regress realized outcomes on predicted probabilities and
 * you get exactly how much of the model's confidence survives contact with
 * settlement. slope = 1 means take it at face value; slope = 0 means the model
 * knows nothing and every position collapses to the prior.
 */
export function shrink(pModel: number, slope: number, prior = BASE_RATE_UP): number {
  const k = Math.max(0, Math.min(1, slope));
  return clampProbability(prior + k * (pModel - prior));
}

/** Keep probabilities strictly inside (0,1) — a 0 or 1 makes Kelly infinite. */
export const clampProbability = (p: number, lo = 0.001, hi = 0.999): number =>
  Math.min(hi, Math.max(lo, p));
