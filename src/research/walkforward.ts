// Walk-forward evaluation, scored in money rather than in likelihood.
//
// Three decisions here are the ones that keep the result honest.
//
// FOLDS ARE ORDERED BY SETTLEMENT, NOT BY DECISION TIME. A window that a trade
// was placed in during July may not settle until August. Splitting on decision
// time would let a model train on the outcome of a window that, at test time,
// had not yet resolved — the subtle half of lookahead, and the half a shuffled
// split hides completely. Training rows are therefore restricted to windows
// whose EXPIRY precedes the first decision in the test fold.
//
// ONE POSITION PER WINDOW IS THE HEADLINE. A window can carry forty qualifying
// fills, and every one of them settles on the same coin flip. Counting them as
// forty trades inflates the trade count, shrinks the apparent error, and
// describes a position size no risk system would allow. Both views are reported;
// the decorrelated one is the one any claim rests on.
//
// THE MARKET IS ALWAYS ON THE SCOREBOARD. Predicting nothing — trusting the
// venue's price — returns exactly zero. Any candidate that cannot beat zero after
// crossing the spread has not found anything, however good its Brier score.

import type { Observation } from "./dataset.js";

export interface Decision {
  /** Expected per-share profit the strategy is claiming. */
  edge: number;
  trade: boolean;
}

export interface Strategy {
  name: string;
  /** Called once per fold with that fold's training rows. */
  fit?: (train: Observation[]) => void;
  decide: (o: Observation) => Decision;
}

export interface Trade {
  at: number;
  marketId: string;
  asset: string;
  intervalSec: number;
  leg: string;
  price: number;
  edge: number;
  /** Realised per-share profit: `won − price`. */
  ret: number;
  won: 0 | 1;
  fold: number;
}

export interface Economics {
  trades: number;
  windows: number;
  stake: number;
  pnl: number;
  /** P&L divided by everything staked. The primary acceptance number. */
  returnOnStake: number;
  meanPerTrade: number;
  medianPerTrade: number;
  winRate: number;
  maxDrawdown: number;
  profitFactor: number | null;
  /** Cluster-bootstrap standard error of return on stake. */
  seReturnOnStake: number;
  tStat: number;
}

const EMPTY: Economics = {
  trades: 0, windows: 0, stake: 0, pnl: 0, returnOnStake: 0, meanPerTrade: 0,
  medianPerTrade: 0, winRate: 0, maxDrawdown: 0, profitFactor: null,
  seReturnOnStake: 0, tStat: 0,
};

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x1_0000_0000; };
}

/**
 * Score a set of trades.
 *
 * Drawdown runs on the cumulative P&L path in stake units, so it is comparable
 * across strategies that stake wildly different totals.
 */
export function economics(trades: Trade[], seed = 11): Economics {
  if (trades.length === 0) return { ...EMPTY };
  const ordered = [...trades].sort((a, b) => a.at - b.at);
  const stake = ordered.reduce((s, t) => s + t.price, 0);
  const pnl = ordered.reduce((s, t) => s + t.ret, 0);

  let cum = 0, peak = 0, dd = 0;
  for (const t of ordered) {
    cum += t.ret;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }

  const gains = ordered.filter((t) => t.ret > 0).reduce((s, t) => s + t.ret, 0);
  const losses = -ordered.filter((t) => t.ret < 0).reduce((s, t) => s + t.ret, 0);
  const sorted = ordered.map((t) => t.ret).sort((a, b) => a - b);
  const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

  // Cluster bootstrap over windows, on return on stake.
  const by = new Map<string, Trade[]>();
  for (const t of ordered) {
    const l = by.get(t.marketId);
    if (l) l.push(t); else by.set(t.marketId, [t]);
  }
  const keys = [...by.keys()];
  const rand = rng(seed);
  const draws: number[] = [];
  for (let b = 0; b < 400; b++) {
    let s = 0, p = 0;
    for (let c = 0; c < keys.length; c++) {
      for (const t of by.get(keys[Math.floor(rand() * keys.length)]!)!) { s += t.price; p += t.ret; }
    }
    if (s > 0) draws.push(p / s);
  }
  const ros = stake > 0 ? pnl / stake : 0;
  const mu = draws.reduce((s, v) => s + v, 0) / Math.max(1, draws.length);
  const se = draws.length > 1 ? Math.sqrt(draws.reduce((s, v) => s + (v - mu) ** 2, 0) / (draws.length - 1)) : 0;

  return {
    trades: ordered.length,
    windows: keys.length,
    stake,
    pnl,
    returnOnStake: ros,
    meanPerTrade: pnl / ordered.length,
    medianPerTrade: mid,
    winRate: ordered.filter((t) => t.won === 1).length / ordered.length,
    maxDrawdown: dd,
    profitFactor: losses > 0 ? gains / losses : null,
    seReturnOnStake: se,
    tStat: se > 0 ? ros / se : 0,
  };
}

/**
 * One entry per settled window, chosen without regard to when it happened.
 *
 * The obvious implementation — keep the earliest qualifying fill — was the
 * version this study started with, and it was wrong in a way worth recording.
 * The first trade in a window turns out to be the single most anomalous
 * observation in the sample (+7.4% against a −0.9% base rate), so "keep the
 * first" quietly loaded every strategy with that anomaly and reported it as
 * decorrelation. Two candidates looked profitable purely because of it.
 *
 * The pick is instead deterministic in the window id, which is independent of
 * position within the window, of price, and of outcome. Deterministic rather
 * than random so the artefact reproduces byte for byte.
 *
 * This view is a cross-check, not the headline. The primary statistic uses every
 * fill with a standard error clustered on the window, which handles the shared
 * outcome without throwing evidence away.
 */
export function oncePerWindow(trades: Trade[]): Trade[] {
  const by = new Map<string, Trade[]>();
  for (const t of trades) {
    const l = by.get(t.marketId);
    if (l) l.push(t); else by.set(t.marketId, [t]);
  }
  const out: Trade[] = [];
  for (const [id, list] of by) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    const ordered = [...list].sort((a, b) => a.at - b.at);
    out.push(ordered[(h >>> 0) % ordered.length]!);
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface Fold {
  index: number;
  trainRows: number;
  trainWindows: number;
  testStart: number;
  testEnd: number;
  testRows: number;
}

export interface WalkForwardResult {
  strategy: string;
  folds: { fold: Fold; all: Economics; once: Economics }[];
  all: Economics;
  once: Economics;
  trades: Trade[];
}

export interface WalkForwardOptions {
  /** Number of test blocks. The first block is training-only. */
  folds?: number;
  /** Rows the model needs before a fold is scored at all. */
  minTrain?: number;
  /**
   * How the blocks are cut.
   *
   * `windows` (the default) gives every fold the same number of SETTLED WINDOWS.
   * `time` gives every fold the same number of seconds, which sounds neutral and
   * is not: this venue's fills are not spread evenly, and on the recorded history
   * equal-time folds put 95% of the data in the training-only block and scored
   * the candidates on the remaining 4.5%. A fold structure that hides most of the
   * evidence is worse than no fold structure, because it still prints a number.
   */
  blocks?: "windows" | "time";
}

/**
 * Expanding-window walk-forward.
 *
 * Blocks are cut on the DECISION time so each test block is a contiguous stretch
 * of live trading, then the training set for that block is everything that had
 * already SETTLED when the block opened.
 */
export function walkForward(rows: Observation[], strategy: Strategy, o: WalkForwardOptions = {}): WalkForwardResult {
  const nFolds = o.folds ?? 5;
  const minTrain = o.minTrain ?? 200;
  const ordered = [...rows].sort((a, b) => a.at - b.at);
  if (ordered.length === 0) {
    return { strategy: strategy.name, folds: [], all: { ...EMPTY }, once: { ...EMPTY }, trades: [] };
  }

  const trades: Trade[] = [];
  const folds: WalkForwardResult["folds"] = [];
  const blocks = buildBlocks(ordered, nFolds, o.blocks ?? "windows");

  for (const block of blocks) {
    const { index: k, rows: test } = block;
    if (test.length === 0) continue;

    // The first decision in the block. Everything the model is allowed to learn
    // from must have SETTLED before this instant — not merely have been decided
    // before it. A window opened in July and settling in August is future
    // information to a trade placed in between, and this is the line that says so.
    const testStart = test[0]!.at;
    const testEnd = block.end;
    const train = ordered.filter((r) => r.expiry <= testStart);
    if (train.length < minTrain) continue;

    strategy.fit?.(train);

    const foldTrades: Trade[] = [];
    for (const r of test) {
      const d = strategy.decide(r);
      if (!d.trade) continue;
      foldTrades.push({
        at: r.at, marketId: r.marketId, asset: r.asset, intervalSec: r.intervalSec,
        leg: r.leg, price: r.price, edge: d.edge, ret: r.ret, won: r.won, fold: k,
      });
    }
    trades.push(...foldTrades);
    folds.push({
      fold: {
        index: k,
        trainRows: train.length,
        trainWindows: new Set(train.map((r) => r.marketId)).size,
        testStart, testEnd, testRows: test.length,
      },
      all: economics(foldTrades),
      once: economics(oncePerWindow(foldTrades)),
    });
  }

  return { strategy: strategy.name, folds, all: economics(trades), once: economics(oncePerWindow(trades)), trades };
}

/**
 * Does a bigger claimed edge actually pay better?
 *
 * The single most informative diagnostic in the whole exercise, and the one the
 * previous generation of this strategy failed: it claimed larger and larger edge
 * and realised no more money. Returned as buckets of claimed edge against what
 * each bucket actually made.
 */
export function edgeBuckets(trades: Trade[], cuts: number[] = [0, 0.01, 0.02, 0.03, 0.05, 0.08, 1]): {
  lo: number; hi: number; trades: number; windows: number; stake: number; pnl: number; returnOnStake: number; meanEdge: number;
}[] {
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const lo = cuts[i]!, hi = cuts[i + 1]!;
    const s = trades.filter((t) => t.edge >= lo && t.edge < hi);
    if (s.length === 0) continue;
    const stake = s.reduce((a, t) => a + t.price, 0);
    const pnl = s.reduce((a, t) => a + t.ret, 0);
    out.push({
      lo, hi, trades: s.length, windows: new Set(s.map((t) => t.marketId)).size,
      stake, pnl, returnOnStake: stake > 0 ? pnl / stake : 0,
      meanEdge: s.reduce((a, t) => a + t.edge, 0) / s.length,
    });
  }
  return out;
}

/** Split economics by an arbitrary key, for the per-asset and per-tenor tables. */
export function breakdown(trades: Trade[], key: (t: Trade) => string): Record<string, Economics> {
  const by = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = key(t);
    const l = by.get(k);
    if (l) l.push(t); else by.set(k, [t]);
  }
  const out: Record<string, Economics> = {};
  for (const [k, v] of [...by.entries()].sort()) out[k] = economics(v);
  return out;
}

interface Block {
  index: number;
  rows: Observation[];
  end: number;
}

/**
 * Cut the sample into test blocks.
 *
 * Window-balanced blocks group by settled window so that every fold carries the
 * same number of independent outcomes, which is the quantity that actually sets
 * the error bar. The first block is training-only and is not returned.
 */
function buildBlocks(ordered: Observation[], nFolds: number, mode: "windows" | "time"): Block[] {
  if (ordered.length === 0) return [];

  if (mode === "time") {
    const t0 = ordered[0]!.at;
    const t1 = ordered[ordered.length - 1]!.at;
    const width = (t1 - t0) / nFolds;
    const out: Block[] = [];
    for (let k = 1; k < nFolds; k++) {
      const from = t0 + width * k;
      const to = k === nFolds - 1 ? t1 + 1 : t0 + width * (k + 1);
      out.push({ index: k, rows: ordered.filter((r) => r.at >= from && r.at < to), end: to });
    }
    return out;
  }

  // Windows in settlement order, split into equal counts.
  const expiryOf = new Map<string, number>();
  for (const r of ordered) {
    const cur = expiryOf.get(r.marketId);
    if (cur === undefined || r.expiry < cur) expiryOf.set(r.marketId, r.expiry);
  }
  const windows = [...expiryOf.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  if (windows.length < nFolds) return [];
  const per = Math.floor(windows.length / nFolds);

  const out: Block[] = [];
  for (let k = 1; k < nFolds; k++) {
    const slice = new Set(windows.slice(k * per, k === nFolds - 1 ? windows.length : (k + 1) * per));
    const rows = ordered.filter((r) => slice.has(r.marketId));
    if (rows.length === 0) continue;
    out.push({ index: k, rows, end: rows[rows.length - 1]!.at + 1 });
  }
  return out;
}
