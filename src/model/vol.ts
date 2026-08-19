// Realized volatility of the underlying, measured rather than assumed.
//
// The kit's oracle-follow strategy makes the same choice and explains why: a
// stalled feed measures as certainty, so an estimate needs a floor, and an
// assumed constant misprices every market the moment the regime changes.

/** A minute bar of the underlying. */
export interface Bar {
  t: number;
  close: number;
}

/** Floor under the per-minute estimate. A flat feed is not a riskless market. */
export const MIN_SIGMA_PER_MIN = 0.0002;

/**
 * Per-minute log-return standard deviation over the bars ending at `endIdx`.
 *
 * `lookback` is in bars. Returns `null` when there is too little history to
 * measure — the caller must skip rather than substitute a guess, because a
 * fabricated sigma produces a confident, wrong probability.
 */
export function sigmaPerMinute(bars: Bar[], endIdx: number, lookback: number): number | null {
  const lo = Math.max(1, endIdx - lookback + 1);
  if (endIdx - lo < 20) return null;
  let sum = 0;
  let n = 0;
  const rets: number[] = [];
  for (let i = lo; i <= endIdx; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (!prev || !cur || prev.close <= 0 || cur.close <= 0) continue;
    const r = Math.log(cur.close / prev.close);
    rets.push(r);
    sum += r;
    n++;
  }
  if (n < 20) return null;
  const mean = sum / n;
  let v = 0;
  for (const r of rets) v += (r - mean) ** 2;
  const sd = Math.sqrt(v / (n - 1));
  return Math.max(sd, MIN_SIGMA_PER_MIN);
}

/**
 * Volatility over the remaining life of a window.
 *
 * Diffusive scaling: sigma grows with the square root of time, so a one-minute
 * measurement extrapolates to `tau` minutes as `sigma * sqrt(tau)`. Extrapolating
 * linearly would let a short-window measurement dominate a long-dated market.
 */
export const sigmaOverHorizon = (sigmaPerMin: number, tauMinutes: number): number =>
  sigmaPerMin * Math.sqrt(Math.max(tauMinutes, 1 / 60));
