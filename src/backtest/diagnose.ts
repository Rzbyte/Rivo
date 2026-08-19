// Why is a well-calibrated model losing money?
//
// Two candidates produce the same symptom (a sub-50% hit rate on positive-edge
// trades) and they call for opposite responses:
//
//   ADVERSE SELECTION — the market is informed. Fills cluster at the moments the
//     model is most wrong, so selecting on "edge > 0" selects for being stale.
//     Response: trade less, or find a different edge. No parameter fixes it.
//
//   STALE INPUTS — our own spot lags the fill by up to two minutes because it
//     comes from minute bars. The contract only LOOKS mispriced because we are
//     pricing it against where the underlying used to be.
//     Response: fix the data, and the edge may well be real.
//
// Telling them apart is the whole job. The tell is how the hit rate behaves as a
// function of edge size and of input lag: real edge gets MORE reliable as it
// grows, manufactured edge gets less.

import type { Chance } from "./replay.js";

export interface Bucket {
  label: string;
  n: number;
  /** What the model claimed the win probability was. */
  claimed: number;
  /** What actually happened. */
  realized: number;
  /** Mean price paid. */
  price: number;
  /** Realised profit per unit staked, at these prices. */
  edgePerStake: number;
}

function summarise(label: string, cs: Chance[]): Bucket {
  const n = cs.length;
  if (n === 0) return { label, n: 0, claimed: NaN, realized: NaN, price: NaN, edgePerStake: NaN };
  let claimed = 0;
  let realized = 0;
  let price = 0;
  let pnl = 0;
  let stake = 0;
  for (const c of cs) {
    claimed += c.fair;
    realized += c.won;
    price += c.price;
    pnl += c.won - c.price;
    stake += c.price;
  }
  return {
    label,
    n,
    claimed: claimed / n,
    realized: realized / n,
    price: price / n,
    edgePerStake: stake > 0 ? pnl / stake : NaN,
  };
}

/** Hit rate by claimed edge. Real edge strengthens with size; artefacts collapse. */
export function byEdge(chances: Chance[]): Bucket[] {
  const edges = [0.02, 0.05, 0.1, 0.2, 0.4, 1];
  const out: Bucket[] = [];
  let lo = 0;
  for (const hi of edges) {
    out.push(summarise(`edge ${lo.toFixed(2)}–${hi.toFixed(2)}`, chances.filter((c) => c.edge >= lo && c.edge < hi)));
    lo = hi;
  }
  return out;
}

/** Hit rate by time to expiry — separates "model is wrong" from "horizon is long". */
export function byHorizon(chances: Chance[]): Bucket[] {
  const bands: [string, number, number][] = [
    ["< 5 min", 0, 5],
    ["5–30 min", 5, 30],
    ["30–120 min", 30, 120],
    ["> 120 min", 120, Number.POSITIVE_INFINITY],
  ];
  return bands.map(([label, lo, hi]) =>
    summarise(
      label,
      chances.filter((c) => {
        const tau = (c.expiry - c.at) / 60;
        return tau >= lo && tau < hi;
      }),
    ),
  );
}

/** Hit rate by how stale our spot was when the chance was priced. */
export function byStaleness(chances: (Chance & { spotLagSec?: number })[]): Bucket[] {
  // Fine bands INSIDE the minute. Bucketing at 60s hides the whole effect: with
  // realized vol near 0.17%/min, a 15-minute window five minutes from expiry has
  // sigma over its remaining life of about 0.38% — so half a minute of lag is
  // already a meaningful fraction of the uncertainty the model is pricing, and
  // near the money it is enough to flip the sign of z.
  const bands: [string, number, number][] = [
    ["lag 0–10s", 0, 10],
    ["lag 10–20s", 10, 20],
    ["lag 20–30s", 20, 30],
    ["lag 30–45s", 30, 45],
    ["lag 45–60s", 45, 60],
    ["lag > 60s", 60, Number.POSITIVE_INFINITY],
  ];
  return bands.map(([label, lo, hi]) =>
    summarise(label, chances.filter((c) => (c.spotLagSec ?? 0) >= lo && (c.spotLagSec ?? 0) < hi)),
  );
}

/**
 * The decisive split: does the leg we WANTED to buy do better or worse than the
 * leg we declined?
 *
 * Every fill offers both legs. If our selection is informative, the chosen side
 * wins more often than the rejected one. If the two are indistinguishable, the
 * model contributes nothing at fill time whatever its average calibration says.
 * If the chosen side wins LESS, we are systematically buying the wrong end of an
 * informed trade.
 */
export function selectionValue(chances: Chance[]): { chosen: Bucket; ifInverted: Bucket } {
  const inverted = chances.map((c) => ({ ...c, won: (1 - c.won) as 0 | 1, price: 1 - c.price }));
  return { chosen: summarise("as selected", chances), ifInverted: summarise("opposite leg", inverted) };
}

export function renderBuckets(title: string, buckets: Bucket[]): string {
  const lines = [title, "-".repeat(84), "  bucket             n      model said   actually won    avg price   P&L per unit staked"];
  for (const b of buckets) {
    if (b.n === 0) continue;
    const gap = b.realized - b.claimed;
    lines.push(
      `  ${b.label.padEnd(18)} ${String(b.n).padStart(6)}   ${b.claimed.toFixed(3).padStart(9)}   ${b.realized.toFixed(3).padStart(12)}   ` +
        `${b.price.toFixed(3).padStart(9)}   ${(b.edgePerStake >= 0 ? "+" : "") + (b.edgePerStake * 100).toFixed(1)}%  ${gap >= 0 ? "" : "(model too bullish)"}`,
    );
  }
  return lines.join("\n");
}
