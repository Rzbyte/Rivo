// Scoring rules for probability forecasts.
//
// A trading model can fail two independent ways, and conflating them wastes
// days. DISCRIMINATION asks whether the model ranks outcomes correctly at all;
// CALIBRATION asks whether its stated confidence is honest. A model with good
// discrimination and bad calibration is fixable — shrink it. A model with no
// discrimination cannot be fixed by any amount of tuning, and every hour spent
// on position sizing for it is wasted. So we measure both, separately.

/** One scored forecast: what the model said, and what settlement decided. */
export interface Prediction {
  /** Model probability that UP wins, in (0,1). */
  p: number;
  /** Realized outcome: 1 if UP won, 0 if DOWN won. */
  y: 0 | 1;
}

/** Mean squared error of the forecast. Lower is better; 0.25 = always saying 0.5. */
export function brierScore(preds: Prediction[]): number {
  if (preds.length === 0) return NaN;
  let s = 0;
  for (const { p, y } of preds) s += (p - y) ** 2;
  return s / preds.length;
}

/** Brier of a constant forecast — the baseline any model must beat. */
export function brierOfConstant(preds: Prediction[], c: number): number {
  if (preds.length === 0) return NaN;
  let s = 0;
  for (const { y } of preds) s += (c - y) ** 2;
  return s / preds.length;
}

/** Skill vs a baseline: fraction of the baseline's error removed. */
export const brierSkill = (model: number, baseline: number): number =>
  baseline > 0 ? 1 - model / baseline : NaN;

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  /** Mean forecast in the bin — where the model said it was. */
  meanP: number;
  /** Realized UP frequency in the bin — where it actually was. */
  freq: number;
}

/**
 * The reliability diagram, as data.
 *
 * Perfect calibration is `meanP === freq` in every bin. The shape of the
 * deviation is the diagnostic: a curve flatter than the diagonal means the model
 * is overconfident at both ends, which is the failure shrinkage repairs.
 */
export function reliability(preds: Prediction[], bins = 10): ReliabilityBin[] {
  const acc = Array.from({ length: bins }, (_, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    n: 0,
    sumP: 0,
    sumY: 0,
  }));
  for (const { p, y } of preds) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    const b = acc[idx];
    if (!b) continue;
    b.n++;
    b.sumP += p;
    b.sumY += y;
  }
  return acc
    .filter((b) => b.n > 0)
    .map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, meanP: b.sumP / b.n, freq: b.sumY / b.n }));
}

/**
 * The shrinkage factor Kelly should use, in closed form.
 *
 * We want the `k` in `p_used = prior + k * (p_model - prior)` that minimises
 * Brier. Differentiating the squared error and solving gives the regression
 * coefficient of the realized outcome on the model's deviation from the prior:
 *
 *     k = sum((y - prior)(p - prior)) / sum((p - prior)^2)
 *
 * k = 1 means the model's confidence is earned. k = 0.4 means only 40% of the
 * edge it claims survives settlement, and betting the full claim is betting a
 * number the data does not support. k <= 0 means the model is anti-predictive.
 */
export function brierOptimalShrinkage(preds: Prediction[], prior: number): number {
  let num = 0;
  let den = 0;
  for (const { p, y } of preds) {
    const d = p - prior;
    num += (y - prior) * d;
    den += d * d;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Area under the ROC curve — does the model RANK correctly, ignoring calibration?
 *
 * Computed as the normalised Mann-Whitney U statistic (rank-sum over the UP
 * cases), which is exact and O(n log n) rather than approximated from a curve.
 * 0.5 is a coin flip; below 0.5 the model is inverted.
 */
export function auc(preds: Prediction[]): number {
  const ups = preds.filter((d) => d.y === 1).length;
  const downs = preds.length - ups;
  if (ups === 0 || downs === 0) return NaN;
  const sorted = [...preds].sort((a, b) => a.p - b.p);
  // Average ranks across ties so a model that outputs constants scores 0.5.
  const ranks = new Array<number>(sorted.length);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.p === sorted[i]!.p) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let rankSumUp = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.y === 1) rankSumUp += ranks[i]!;
  return (rankSumUp - (ups * (ups + 1)) / 2) / (ups * downs);
}

/** Mean negative log-likelihood. Punishes confident errors far harder than Brier. */
export function logLoss(preds: Prediction[]): number {
  if (preds.length === 0) return NaN;
  let s = 0;
  for (const { p, y } of preds) {
    const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
    s += y === 1 ? -Math.log(q) : -Math.log(1 - q);
  }
  return s / preds.length;
}

// ---------------------------------------------------------------------------
// Calibration maps
//
// A single multiplicative shrink assumes the model's error is a slope. Measured
// on real settlements it is not: the reliability curve is over-confident on the
// DOWN side and accurate on the UP side, which is a shape no scalar can express.
// A two-parameter map in logit space can — one term for how much of the model's
// confidence to keep, one for a standing directional bias.
// ---------------------------------------------------------------------------

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
/** log(1 + e^x), computed so a large x does not overflow before the log. */
const softplus = (x: number) => (x > 30 ? x : x < -30 ? Math.exp(x) : Math.log1p(Math.exp(x)));

/** `p_calibrated = sigmoid(a * logit(p_model) + b)`. */
export interface PlattMap {
  a: number;
  b: number;
}

/** The identity map — keeps the model's probabilities untouched. */
export const IDENTITY_MAP: PlattMap = { a: 1, b: 0 };

export const applyPlatt = (map: PlattMap, p: number): number =>
  clamp01(sigmoid(map.a * logit(clamp01(p)) + map.b));

/**
 * Fit Platt scaling by iteratively reweighted least squares.
 *
 * This is logistic regression of the realized outcome on the model's own logit,
 * so `a` reports how much of the model's confidence survives settlement and `b`
 * reports any standing lean. `a = 1, b = 0` means the model needs no correction
 * at all — which is a result worth being able to reach, so the fit is allowed to
 * land there rather than being forced to move.
 */
export function fitPlatt(preds: Prediction[], iterations = 50): PlattMap {
  if (preds.length < 50) return IDENTITY_MAP;
  const xs = preds.map((d) => logit(clamp01(d.p)));
  const ys = preds.map((d) => d.y);

  // Mean log-likelihood, used to decide whether a step was actually an improvement.
  const ll = (a: number, b: number): number => {
    let s = 0;
    for (let i = 0; i < xs.length; i++) {
      const z = a * xs[i]! + b;
      // log sigmoid(z) for y=1, log(1-sigmoid(z)) for y=0, written to avoid
      // overflow at large |z| — which is exactly where this fit gets into trouble.
      s += ys[i]! === 1 ? -softplus(-z) : -softplus(z);
    }
    return s / xs.length;
  };

  let a = 1;
  let b = 0;
  let current = ll(a, b);

  for (let it = 0; it < iterations; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      const mu = sigmoid(a * x + b);
      const r = ys[i]! - mu;
      const w = Math.max(mu * (1 - mu), 1e-9);
      g0 += r * x;
      g1 += r;
      h00 += w * x * x;
      h01 += w * x;
      h11 += w;
    }
    // Ridge on the diagonal. Once the weights collapse toward their floor the
    // information matrix is near-singular, and an undamped solve turns a finite
    // gradient into an astronomical step.
    const ridge = 1e-6 * xs.length;
    const d00 = h00 + ridge;
    const d11 = h11 + ridge;
    const det = d00 * d11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    let da = (d11 * g0 - h01 * g1) / det;
    let db = (d00 * g1 - h01 * g0) / det;
    if (!Number.isFinite(da) || !Number.isFinite(db)) break;

    // Backtracking line search. A pure Newton step is not guaranteed to improve
    // the likelihood, and on an overconfident model it overshoots so far that the
    // next iteration is worse still — measured: `a` reaching 8.7e7 on a model
    // claiming 0.99 while being right 60% of the time. Halving until the step
    // actually helps turns that into a convergent fit.
    let step = 1;
    let improved = false;
    for (let back = 0; back < 30; back++) {
      const na = a + step * da;
      const nb = b + step * db;
      const next = ll(na, nb);
      if (Number.isFinite(next) && next > current) {
        a = na;
        b = nb;
        current = next;
        improved = true;
        break;
      }
      step /= 2;
    }
    if (!improved) break; // at an optimum, or no direction improves — stop cleanly
    if (Math.abs(step * da) < 1e-10 && Math.abs(step * db) < 1e-10) break;
  }

  return Number.isFinite(a) && Number.isFinite(b) ? { a, b } : IDENTITY_MAP;
}
