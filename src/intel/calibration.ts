// Is 67% actually 67%?
//
// DreamDEX quotes a probability. Nothing on the venue tells you whether
// contracts that quoted 67% went on to settle true about 67% of the time, and
// that is the only question a price of 0.67 actually raises. This module answers
// it from settled outcomes.
//
// It is built on `src/research/dataset.ts` rather than beside it, because that
// module already solved the three problems this one would otherwise re-solve
// badly:
//
//   * LEAKAGE. Features may only read bars that had closed and fills that had
//     happened. Calibration needs the same discipline for a different reason —
//     a probability read after the fact is not a probability.
//   * EXECUTABILITY. A fill proves one side was takeable. Calibrating on a
//     midpoint measures a price nobody could trade, which is a fine academic
//     exercise and a misleading product.
//   * CLUSTERING. Every fill inside one settled window shares one outcome.
//     Forty rows from a window that resolved UP are forty copies of one coin
//     flip, and counting them as forty observations understates every interval
//     by roughly the square root of the ratio.
//
// The third is the one that makes or breaks a calibration claim, so the window
// count travels with every number here and the intervals are computed by
// resampling windows rather than rows.

import type { Observation } from "../research/dataset.js";
import { TRADEABLE_CADENCES, matchesCadence } from "../core/venue.js";

/** How an observation was sampled. Reported, never inferred by the reader. */
export type SamplingBasis =
  /** One row per fill, per executable leg. Correlated within a window. */
  | "snapshot"
  /** One row per settled window, chosen independently of position within it. */
  | "window";

export interface Bucket {
  /** Inclusive lower bound of quoted probability. */
  lo: number;
  /** Exclusive upper bound, except the last bucket which is inclusive. */
  hi: number;
  /** Rows in this bucket. */
  n: number;
  /** Distinct settled windows behind those rows — the independent unit. */
  windows: number;
  /** Mean quoted probability, i.e. what the venue said. */
  quoted: number;
  /** Fraction that actually settled true. */
  realized: number;
  /** realized − quoted. Positive means the market was UNDERconfident. */
  gap: number;
  /** Cluster-bootstrap standard error of `realized`. */
  se: number;
  /** 95% interval on `realized`, from the same resampling. */
  lo95: number;
  hi95: number;
  /** True when the window count is too small to say anything. */
  thin: boolean;
}

export interface CalibrationReport {
  buckets: Bucket[];
  /** Every row considered. */
  n: number;
  /** Independent outcomes behind them. */
  windows: number;
  /** Unix seconds. */
  from: number;
  to: number;
  basis: SamplingBasis;
  /** Executable side only, or both legs of every fill. */
  executableOnly: boolean;
  /** Windows below which a bucket is marked `thin` and makes no claim. */
  minWindows: number;
  /** Brier score over the whole sample: mean (quoted − outcome)². */
  brier: number;
  /** Brier of always quoting the base rate. Below 1 means the venue adds information. */
  brierBase: number;
  /** 1 − brier/brierBase. Positive means the quoted probabilities carry skill. */
  skill: number;
  /** Fraction of rows that settled true. */
  baseRate: number;
}

/**
 * Five-point buckets, all the way across.
 *
 * Uniform rather than wider at the tails, because every bucket then reads as one
 * sentence a person can check — "contracts priced 65 to 70 per cent settled true
 * this often" — and a reader comparing two buckets is comparing equal widths. A
 * variable-width scheme buys a little sample size in the tails and costs that,
 * which is the wrong trade for the feature whose entire job is legibility.
 */
export const DEFAULT_EDGES = [
  0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5,
  0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1,
] as const;

/** Deterministic PRNG — a published interval has to reproduce exactly. */
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
 * One row per settled window, chosen independently of when it happened.
 *
 * Keeping the earliest fill would be simpler and wrong: the first trade in a
 * window is the most anomalous observation in this venue's history, so "keep the
 * first" silently loads every bucket with that anomaly. The pick is a hash of
 * the window id, which is independent of price, of position within the window,
 * and of outcome — and deterministic, so the report reproduces.
 */
export function onePerWindow(rows: Observation[]): Observation[] {
  const by = new Map<string, Observation[]>();
  for (const r of rows) {
    const l = by.get(r.marketId);
    if (l) l.push(r);
    else by.set(r.marketId, [r]);
  }
  const out: Observation[] = [];
  for (const [id, list] of by) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const ordered = [...list].sort((a, b) => a.at - b.at);
    out.push(ordered[(h >>> 0) % ordered.length]!);
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface CalibrationOptions {
  edges?: readonly number[];
  basis?: SamplingBasis;
  /** Windows required before a bucket is allowed to make a claim. */
  minWindows?: number;
  bootstrap?: number;
  seed?: number;
}

/**
 * Measure quoted probability against what actually happened.
 *
 * `rows` must already be filtered to the universe being claimed about —
 * executable side, asset, tenor. This function does not filter, because a
 * report that silently drops rows is a report nobody can reproduce.
 */
export function calibrate(rows: Observation[], o: CalibrationOptions = {}): CalibrationReport {
  const basis = o.basis ?? "window";
  const edges = o.edges ?? DEFAULT_EDGES;
  const minWindows = o.minWindows ?? 30;
  const B = o.bootstrap ?? 400;

  const sample = basis === "window" ? onePerWindow(rows) : rows;
  const windows = new Set(sample.map((r) => r.marketId)).size;
  const from = sample.length ? Math.min(...sample.map((r) => r.at)) : 0;
  const to = sample.length ? Math.max(...sample.map((r) => r.at)) : 0;

  const baseRate = sample.length ? sample.reduce((s, r) => s + r.won, 0) / sample.length : 0;
  const brier = sample.length ? sample.reduce((s, r) => s + (r.price - r.won) ** 2, 0) / sample.length : 0;
  const brierBase = sample.length ? sample.reduce((s, r) => s + (baseRate - r.won) ** 2, 0) / sample.length : 0;

  const buckets: Bucket[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]!;
    const hi = edges[i + 1]!;
    const last = i === edges.length - 2;
    const inBucket = sample.filter((r) => r.price >= lo && (last ? r.price <= hi : r.price < hi));
    if (inBucket.length === 0) continue;

    const byWindow = new Map<string, Observation[]>();
    for (const r of inBucket) {
      const l = byWindow.get(r.marketId);
      if (l) l.push(r);
      else byWindow.set(r.marketId, [r]);
    }
    const keys = [...byWindow.keys()];
    const quoted = inBucket.reduce((s, r) => s + r.price, 0) / inBucket.length;
    const realized = inBucket.reduce((s, r) => s + r.won, 0) / inBucket.length;

    // Resample WINDOWS, not rows. This is the whole difference between an
    // interval that means something and one that flatters the sample.
    const rand = rng((o.seed ?? 17) + i);
    const draws: number[] = [];
    for (let b = 0; b < B; b++) {
      let hits = 0;
      let count = 0;
      for (let c = 0; c < keys.length; c++) {
        for (const r of byWindow.get(keys[Math.floor(rand() * keys.length)]!)!) {
          hits += r.won;
          count++;
        }
      }
      if (count > 0) draws.push(hits / count);
    }
    draws.sort((a, b) => a - b);
    const mean = draws.reduce((s, v) => s + v, 0) / Math.max(1, draws.length);
    const se = draws.length > 1 ? Math.sqrt(draws.reduce((s, v) => s + (v - mean) ** 2, 0) / (draws.length - 1)) : 0;

    buckets.push({
      lo, hi,
      n: inBucket.length,
      windows: keys.length,
      quoted, realized,
      gap: realized - quoted,
      se,
      lo95: draws.length ? draws[Math.floor(0.025 * draws.length)]! : realized,
      hi95: draws.length ? draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))]! : realized,
      thin: keys.length < minWindows,
    });
  }

  return {
    buckets,
    n: sample.length,
    windows,
    from, to,
    basis,
    executableOnly: sample.every((r) => r.executable),
    minWindows,
    brier,
    brierBase,
    skill: brierBase > 0 ? 1 - brier / brierBase : 0,
    baseRate,
  };
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

/**
 * Which comparable set a number came from.
 *
 * A market card saying "historical realized 61%" is worthless unless the reader
 * can find out what 61% is the realized rate OF. BTC 15-minute contracts and
 * ETH daily contracts are different populations, and pooling them to reach a
 * comfortable sample size answers a question nobody asked.
 */
export interface Cohort {
  asset: string | null;
  intervalSec: number | null;
}

export const GLOBAL_COHORT: Cohort = { asset: null, intervalSec: null };

/** Human-readable, and specific enough to be checkable. */
export function cohortLabel(c: Cohort): string {
  if (c.asset && c.intervalSec) return `${c.asset} ${tenorWords(c.intervalSec)}`;
  if (c.asset) return `${c.asset}, all tenors`;
  if (c.intervalSec) return `all assets, ${tenorWords(c.intervalSec)}`;
  return "all assets and tenors";
}

function tenorWords(sec: number): string {
  if (sec % 86_400 === 0) return `${sec / 86_400}d`;
  if (sec % 3_600 === 0) return `${Math.round(sec / 3_600)}h`;
  return `${Math.round(sec / 60)}m`;
}

/**
 * The order to try, most specific first.
 *
 * Tenor-without-asset sits above global because a 15-minute contract on either
 * underlying is closer to another 15-minute contract than it is to a daily one:
 * the thing that moves a calibration curve most is how much can happen before
 * settlement.
 */
export function cohortChain(asset: string, intervalSec: number): Cohort[] {
  const tenor = canonicalTenor(intervalSec);
  return [
    { asset, intervalSec: tenor },
    { asset, intervalSec: null },
    { asset: null, intervalSec: tenor },
    GLOBAL_COHORT,
  ];
}

export const sameCohort = (a: Cohort, b: Cohort): boolean =>
  a.asset === b.asset && a.intervalSec === b.intervalSec;

export interface CohortLookup {
  /** The bucket that covered the price, or null when none did. */
  bucket: Bucket | null;
  /** Which cohort actually answered. Always reported. */
  cohort: Cohort;
  /** True when a more specific cohort existed but was too thin to use. */
  fellBack: boolean;
  /**
   * When the answering cohort was measured, and over how many windows.
   *
   * Travels with the bucket because a realized frequency without a date range
   * is a number nobody can date-check. A card can then say "BTC 15m, 30 windows,
   * 22 Jul – 19 Aug" instead of asking a reader to trust 3.3%.
   */
  period: { from: number; to: number; windows: number } | null;
}

/**
 * Find the most specific cohort that can honestly answer for this price.
 *
 * Falls back only on sample size, never on convenience, and reports which
 * cohort answered so the number can be traced. A thin bucket at the bottom of
 * the chain is returned anyway — marked thin — because "we looked and the
 * sample is small" is information, and silence is not.
 */
export function lookupCohort(
  reports: Map<string, CalibrationReport>,
  asset: string,
  intervalSec: number,
  price: number,
): CohortLookup {
  const chain = cohortChain(asset, intervalSec);
  let firstFound: CohortLookup | null = null;

  for (const c of chain) {
    const report = reports.get(cohortKey(c));
    if (!report) continue;
    const bucket = report.buckets.find((b) => price >= b.lo && (b.hi === 1 ? price <= b.hi : price < b.hi));
    if (!bucket) continue;
    const hit: CohortLookup = {
      bucket, cohort: c, fellBack: !sameCohort(c, chain[0]!),
      period: { from: report.from, to: report.to, windows: report.windows },
    };
    if (!bucket.thin) return hit;
    // Remember the most specific answer we saw, in case nothing thicker exists.
    firstFound ??= hit;
  }
  return firstFound ?? { bucket: null, cohort: chain[0]!, fellBack: false, period: null };
}

/**
 * The canonical tenor for an observed interval.
 *
 * Windows drift: the venue reports 898 and 900, 3598 and 3600, for what is one
 * series. Keying cohorts on the raw number split "BTC 15m" into a cohort of 298
 * windows and one of 2, which made every sample look smaller than it is and put
 * usable buckets below the floor for no reason. `matchesCadence` already
 * describes the tolerance the rest of the engine uses.
 */
export function canonicalTenor(sec: number): number {
  for (const c of TRADEABLE_CADENCES) if (matchesCadence(sec, c)) return c;
  return sec;
}

/** Stable key for a cohort, for maps and for the database. */
export const cohortKey = (c: Cohort): string => `${c.asset ?? "*"}:${c.intervalSec ?? "*"}`;

/** Split rows into the cohort they belong to, plus every parent cohort. */
export function cohortsOf(rows: Observation[]): Map<string, { cohort: Cohort; rows: Observation[] }> {
  const out = new Map<string, { cohort: Cohort; rows: Observation[] }>();
  const add = (c: Cohort, r: Observation): void => {
    const k = cohortKey(c);
    const e = out.get(k);
    if (e) e.rows.push(r);
    else out.set(k, { cohort: c, rows: [r] });
  };
  for (const r of rows) {
    const tenor = canonicalTenor(r.intervalSec);
    add({ asset: r.asset, intervalSec: tenor }, r);
    add({ asset: r.asset, intervalSec: null }, r);
    add({ asset: null, intervalSec: tenor }, r);
    add(GLOBAL_COHORT, r);
  }
  return out;
}
