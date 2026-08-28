// "Does anything simple clear the spread on Event Contracts?"
//
// `docs/ALPHA-RESEARCH.md` answers that for Rivo's own model — no — and one
// strategy failing is a fact about that strategy. This aggregates the shadow
// records of every registered agent into the wider answer, which is the thing a
// builder arriving at this venue actually needs before they spend anything.
//
// THE UNIT IS THE WINDOW, NOT THE ROW. `docs/CALIBRATION.md` states the reason
// and it applies with more force here: forty decisions inside one settled
// contract share one outcome, so treating them as forty observations shrinks
// every interval by a factor of six and reports a precision nobody has. The
// point estimate is pooled across rows; the INTERVAL is bootstrapped over
// windows.
//
// This is not a ranking. There is no rank field, no score, and no winner —
// `docs/submission/judge-faq.md` refuses that and DreamDEX runs Algo Arena for
// competition. What comes out is a distribution with a sample size and an
// interval on every row, `coin-flip` among them as the null hypothesis.

/** One settled, sized decision. */
export interface Entry {
  /** The settled contract this decision was made inside. The cluster. */
  marketId: string;
  /** Collateral staked: entry price × size. */
  stake: number;
  /** Realised profit in collateral: (outcome − entry) × size. */
  pnl: number;
  /** Whether this leg paid out. */
  won: 0 | 1;
}

export interface BreadthStat {
  /** Settled decisions that were sized. */
  entered: number;
  /** Distinct settled contracts behind them. The real sample size. */
  windows: number;
  stake: number;
  pnl: number;
  /** Σpnl / Σstake. Null when nothing was staked. */
  returnOnStake: number | null;
  hitRate: number | null;
  /** Cluster-bootstrap 95% interval on `returnOnStake`. Null when unbootstrappable. */
  lo95: number | null;
  hi95: number | null;
  /** Too few windows to conclude anything from. Reported, never hidden. */
  thin: boolean;
}

/**
 * Below this, an interval is wide enough that the row says nothing.
 *
 * Matched to the acceptance gate in `src/research/gating.ts`, which requires 200
 * windows before a strategy may be called anything at all. A row under it is
 * published with its interval and marked `thin` rather than omitted: a strategy
 * that has not been asked enough times is a different fact from one that failed.
 */
export const MIN_WINDOWS = 200;

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

export interface BreadthOptions {
  /** Bootstrap draws. */
  bootstrap?: number;
  seed?: number;
}

export function summarise(entries: readonly Entry[], o: BreadthOptions = {}): BreadthStat {
  const empty: BreadthStat = {
    entered: 0, windows: 0, stake: 0, pnl: 0,
    returnOnStake: null, hitRate: null, lo95: null, hi95: null, thin: true,
  };
  if (entries.length === 0) return empty;

  const byWindow = new Map<string, Entry[]>();
  for (const e of entries) {
    const l = byWindow.get(e.marketId);
    if (l) l.push(e);
    else byWindow.set(e.marketId, [e]);
  }
  const keys = [...byWindow.keys()];

  const stake = entries.reduce((s, e) => s + e.stake, 0);
  const pnl = entries.reduce((s, e) => s + e.pnl, 0);
  const hitRate = entries.reduce((s, e) => s + e.won, 0) / entries.length;
  // A strategy can enter with a zero stake if the venue normalised its size to
  // nothing. Dividing by that would report Infinity as a return.
  const returnOnStake = stake > 0 ? pnl / stake : null;

  // Resample WINDOWS, not rows.
  const B = o.bootstrap ?? 400;
  const rand = rng(o.seed ?? 17);
  const draws: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    let p = 0;
    for (let c = 0; c < keys.length; c++) {
      for (const e of byWindow.get(keys[Math.floor(rand() * keys.length)]!)!) {
        s += e.stake;
        p += e.pnl;
      }
    }
    if (s > 0) draws.push(p / s);
  }
  draws.sort((a, b) => a - b);

  return {
    entered: entries.length,
    windows: keys.length,
    stake,
    pnl,
    returnOnStake,
    hitRate,
    lo95: draws.length ? draws[Math.floor(0.025 * draws.length)]! : null,
    hi95: draws.length ? draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))]! : null,
    thin: keys.length < MIN_WINDOWS,
  };
}

/**
 * Whether an interval excludes zero — the only claim this study is entitled to make.
 *
 * Deliberately not "is it profitable": a point estimate above zero on a wide
 * interval is a number, not a finding. Returns null when the row is thin, so a
 * caller cannot accidentally read "inconclusive" as "no".
 */
export function verdict(s: BreadthStat): "CLEARS_THE_SPREAD" | "LOSES" | "INCONCLUSIVE" | null {
  if (s.thin || s.lo95 === null || s.hi95 === null) return null;
  if (s.lo95 > 0) return "CLEARS_THE_SPREAD";
  if (s.hi95 < 0) return "LOSES";
  return "INCONCLUSIVE";
}
