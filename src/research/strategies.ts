// The candidates, including the ones expected to lose.
//
// Every baseline the brief requires is here and stays here whatever it scores.
// A comparison table that quietly drops its losers is not evidence, and the two
// losers below — trusting the diffusion gap, and taking any positive edge — are
// the strategy this repository actually shipped. Their numbers are the reason
// the research question changed.
//
// One threshold in this file is dishonest if left unqualified. `favourite-0.90`
// uses a cutoff found by looking at the whole sample, test folds included, so it
// cannot be read as an out-of-sample result. It is kept because the honest
// version — `favourite-learned`, which re-derives its cutoff inside each
// training fold — is only interpretable next to it: if the two disagree, the
// cutoff was luck.

import type { Observation } from "./dataset.js";
import { featureVector } from "./dataset.js";
import { fitRidge, predict, type RidgeModel } from "./residual.js";
import type { Strategy } from "./walkforward.js";

/** Trust the venue. Predicts no correction, so it never crosses a spread. */
export const marketOnly = (): Strategy => ({
  name: "market-only (trust the price)",
  decide: () => ({ edge: 0, trade: false }),
});

/** What Rivo ships today: an independent fair value, and the whole gap read as edge. */
export const diffusion = (minEdge: number): Strategy => ({
  name: `diffusion fair − price ≥ ${minEdge.toFixed(2)}`,
  decide: (o) => ({ edge: o.diffusionGap, trade: o.diffusionGap >= minEdge }),
});

/** The same forecast with no floor at all — the widest version of the old idea. */
export const anyPositiveEdge = (): Strategy => ({
  name: "diffusion fair − price > 0",
  decide: (o) => ({ edge: o.diffusionGap, trade: o.diffusionGap > 0 }),
});

/** A fixed price cutoff. In-sample by construction; see the file header. */
export const favouriteFixed = (cut: number): Strategy => ({
  name: `price ≥ ${cut.toFixed(2)} (cutoff fixed in-sample)`,
  decide: (o) => ({ edge: Math.max(0, o.price - cut), trade: o.price >= cut }),
});

/**
 * The same idea with the cutoff re-derived inside each training fold.
 *
 * Walks a grid from the top down and takes the lowest cutoff that still cleared
 * `minMean` per share on training data with at least `minWindows` settled
 * windows behind it. The window floor is what stops the grid from selecting a
 * cutoff supported by three lucky expiries.
 */
export const favouriteLearned = (minMean = 0.005, minWindows = 30): Strategy => {
  let cut = Number.POSITIVE_INFINITY;
  return {
    name: "price ≥ cutoff learned per fold",
    fit(train) {
      cut = Number.POSITIVE_INFINITY;
      for (const c of [0.98, 0.96, 0.94, 0.92, 0.9, 0.88, 0.85, 0.8, 0.75, 0.7]) {
        const s = train.filter((r) => r.price >= c);
        if (s.length === 0) continue;
        const windows = new Set(s.map((r) => r.marketId)).size;
        if (windows < minWindows) continue;
        const mean = s.reduce((a, r) => a + r.ret, 0) / s.length;
        if (mean >= minMean) cut = c;
      }
    },
    decide: (o) => ({ edge: Math.max(0, o.price - cut), trade: o.price >= cut }),
  };
};

export interface ResidualOptions {
  /** Per-share expected profit required before crossing the spread. */
  threshold?: number;
  /** Standard errors subtracted from the point estimate. Zero trades the raw estimate. */
  k?: number;
  lambda?: number;
  bootstrap?: number;
  /** Fraction of the predicted correction to believe. 1 is no shrinkage. */
  shrink?: number;
}

/**
 * The residual candidate: predict `settled − price`, trade what survives.
 *
 * `k > 0` subtracts a cluster-bootstrap standard error from the estimate, so a
 * prediction of +0.035 ± 0.025 is treated as +0.010 and usually declined. That
 * is the whole answer to the winner's curse: the trades a point estimate likes
 * most are disproportionately the ones where the estimate is largest by luck.
 */
export const residual = (o: ResidualOptions = {}): Strategy => {
  const threshold = o.threshold ?? 0.01;
  const k = o.k ?? 0;
  const shrink = o.shrink ?? 1;
  let model: RidgeModel | null = null;
  const label = [
    "residual ridge",
    shrink !== 1 ? `shrunk ×${shrink}` : null,
    k > 0 ? `LCB −${k}σ` : null,
    `≥ ${threshold.toFixed(3)}`,
  ].filter(Boolean).join(" · ");

  return {
    name: label,
    fit(train) {
      model = fitRidge(
        train.map(featureVector),
        train.map((r) => r.ret),
        train.map((r) => r.marketId),
        { lambda: o.lambda ?? 1e-3, bootstrap: o.bootstrap ?? 24, seed: 7 },
      );
    },
    decide(obs) {
      if (!model) return { edge: 0, trade: false };
      const { mu, sd } = predict(model, featureVector(obs));
      const edge = shrink * mu - k * sd;
      return { edge, trade: edge >= threshold };
    },
  };
};

/**
 * Take every fill that was demonstrably available. No signal at all.
 *
 * Not a strategy anyone would run — it is the base rate, and on this venue it is
 * the number every other candidate has to be read against. Over the recorded
 * history it swings from −2.0% in the busy days of July to +4.9% in the quiet
 * weeks that followed, which means a candidate scoring +3% in the second period
 * has not beaten anything. Omitting this row is how a period effect gets
 * published as alpha.
 */
export const takeEverything = (): Strategy => ({
  name: "take every executable fill (base rate)",
  decide: (o) => ({ edge: -o.price + 0.5, trade: true }),
});

/**
 * Only the first trade in a window.
 *
 * Knowable at decision time — it asks whether anything has traded yet, not what
 * will trade later — and the one condition out of twenty-three that kept its
 * sign across both regimes. Kept as a named candidate so the record shows what
 * was tested and how it failed: the whole result rests on the final block, and
 * removing that block takes it from +7.7% to +2.0%.
 */
export const firstFill = (): Strategy => ({
  name: "first trade in the window",
  decide: (o) => ({ edge: 0, trade: o.fillsBefore === 0 }),
});
