// Ridge regression on the market-relative residual, with an honest error bar.
//
// The model predicts `settled − price`, so a prediction IS an expected per-share
// P&L and needs no translation into economics later. The intercept is fitted,
// features are standardised on the TRAINING fold only, and the penalty is applied
// to slopes but never to the intercept — penalising it would shrink the average
// residual toward zero, which is precisely the quantity being estimated.
//
// Uncertainty comes from a cluster bootstrap rather than the textbook ridge
// variance. Every fill inside a settled window shares one outcome, so the usual
// formula, which assumes independent rows, reports a confidence interval several
// times too narrow. Refitting on windows resampled with replacement makes the
// error bar respect the thing that actually varies.

/** A fitted model: standardisation, coefficients, and the ensemble spread. */
export interface RidgeModel {
  mean: number[];
  sd: number[];
  /** Coefficients on the STANDARDISED features. */
  beta: number[];
  intercept: number;
  /** Bootstrap members, used for the prediction interval. */
  ensemble: { beta: number[]; intercept: number }[];
  n: number;
  clusters: number;
}

/** Solve `A x = b` for a small symmetric positive-definite A. */
function solveSPD(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-12) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]!;
    for (let j = c; j <= n; j++) m[c]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      if (f === 0) continue;
      for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((r) => r[n]!);
}

function fitOne(X: number[][], y: number[], lambda: number): { beta: number[]; intercept: number } | null {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) return null;
  // Centre y so the intercept is recovered afterwards and never penalised.
  const yBar = y.reduce((s, v) => s + v, 0) / n;
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i]!;
    const yi = y[i]! - yBar;
    for (let j = 0; j < p; j++) {
      b[j]! += xi[j]! * yi;
      for (let k = j; k < p; k++) A[j]![k]! += xi[j]! * xi[k]!;
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) A[j]![k] = A[k]![j]!;
    A[j]![j]! += lambda * n;
  }
  const beta = solveSPD(A, b);
  if (!beta) return null;
  return { beta, intercept: yBar };
}

export interface FitOptions {
  lambda?: number;
  /** Bootstrap members. Zero disables the interval. */
  bootstrap?: number;
  seed?: number;
}

/** Deterministic PRNG: a research artefact has to reproduce exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Fit on rows grouped into clusters.
 *
 * `clusterOf` names the settled window a row belongs to. Rows are never
 * resampled individually — a bootstrap that did would treat forty fills from one
 * window as forty independent facts and manufacture confidence.
 */
export function fitRidge(
  rowsX: number[][],
  rowsY: number[],
  clusterOf: string[],
  o: FitOptions = {},
): RidgeModel | null {
  const lambda = o.lambda ?? 1e-3;
  const n = rowsX.length;
  const p = rowsX[0]?.length ?? 0;
  if (n < p + 2) return null;

  const mean = new Array<number>(p).fill(0);
  const sd = new Array<number>(p).fill(0);
  for (const x of rowsX) for (let j = 0; j < p; j++) mean[j]! += x[j]! / n;
  for (const x of rowsX) for (let j = 0; j < p; j++) sd[j]! += (x[j]! - mean[j]!) ** 2 / n;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]!) || 1;

  const Z = rowsX.map((x) => x.map((v, j) => (v - mean[j]!) / sd[j]!));
  const base = fitOne(Z, rowsY, lambda);
  if (!base) return null;

  const byCluster = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = clusterOf[i]!;
    const list = byCluster.get(k);
    if (list) list.push(i);
    else byCluster.set(k, [i]);
  }
  const keys = [...byCluster.keys()];

  const ensemble: { beta: number[]; intercept: number }[] = [];
  const B = o.bootstrap ?? 24;
  const rand = rng(o.seed ?? 7);
  for (let b = 0; b < B; b++) {
    const zi: number[][] = [];
    const yi: number[] = [];
    for (let c = 0; c < keys.length; c++) {
      for (const i of byCluster.get(keys[Math.floor(rand() * keys.length)]!)!) {
        zi.push(Z[i]!);
        yi.push(rowsY[i]!);
      }
    }
    const f = fitOne(zi, yi, lambda);
    if (f) ensemble.push(f);
  }

  return { mean, sd, beta: base.beta, intercept: base.intercept, ensemble, n, clusters: keys.length };
}

/** Point prediction and the ensemble standard deviation around it. */
export function predict(m: RidgeModel, x: number[]): { mu: number; sd: number } {
  const z = x.map((v, j) => (v - m.mean[j]!) / m.sd[j]!);
  const dot = (beta: number[], intercept: number): number => {
    let s = intercept;
    for (let j = 0; j < z.length; j++) s += beta[j]! * z[j]!;
    return s;
  };
  const mu = dot(m.beta, m.intercept);
  if (m.ensemble.length < 2) return { mu, sd: 0 };
  const preds = m.ensemble.map((e) => dot(e.beta, e.intercept));
  const mean = preds.reduce((s, v) => s + v, 0) / preds.length;
  const varr = preds.reduce((s, v) => s + (v - mean) ** 2, 0) / (preds.length - 1);
  return { mu, sd: Math.sqrt(varr) };
}
