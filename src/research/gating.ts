// The gate between "a backtest looked good" and "this spends a user's money".
//
// Every acceptance rule the research brief lays down is expressed here as code
// and evaluated against measured results, so a candidate's status is computed
// rather than asserted. A README can claim a strategy was validated. This cannot:
// it takes the fold-by-fold economics and returns the reasons a candidate fails,
// and an empty reason list is the only thing that produces VALIDATED.
//
// The default for anything new is SHADOW_ONLY. That is not caution for its own
// sake — the incumbent strategy in this repository reached production on a
// forecast that was genuinely accurate, and lost 30.8% of capital anyway.
// Accuracy arriving before economics is the normal case, not the exception.

import type { Economics } from "./walkforward.js";

export type StrategyState =
  /** Never evaluated. Cannot trade, cannot shadow. */
  | "UNVALIDATED"
  /** May produce decisions and record hypothetical fills. May NOT sign. */
  | "SHADOW_ONLY"
  /** Passed every criterion below on out-of-sample data. May be executed. */
  | "VALIDATED"
  /** Evaluated and failed. Kept, with its reasons, so it is not retried blind. */
  | "REJECTED";

/** Only one state may spend money. */
export function mayExecuteLive(state: StrategyState): boolean {
  return state === "VALIDATED";
}

export interface FoldEconomics {
  fold: number;
  economics: Economics;
}

export interface Acceptance {
  /** Out-of-sample return on stake, aggregated over folds. */
  minReturnOnStake: number;
  /** Settled windows — the independent unit, not the fill count. */
  minWindows: number;
  /** Folds that must be non-negative. */
  minPositiveFolds: number;
  /** Cluster-bootstrap t on return on stake. */
  minTStat: number;
  /** Drawdown as a fraction of total stake. */
  maxDrawdownOfStake: number;
  /**
   * The result must survive deleting its single best fold.
   *
   * This is the criterion the strongest candidate in the study failed: +7.7%
   * became +2.0% when one block of 126 windows was removed, because that block
   * held 78% of the profit.
   */
  survivesBestFoldRemoval: boolean;
  /** Must beat the do-nothing baseline, and the period's own base rate. */
  mustBeatBaseRate: boolean;
}

export const DEFAULT_ACCEPTANCE: Acceptance = {
  minReturnOnStake: 0.02,
  minWindows: 200,
  minPositiveFolds: 3,
  minTStat: 2,
  maxDrawdownOfStake: 0.25,
  survivesBestFoldRemoval: true,
  mustBeatBaseRate: true,
};

export interface Verdict {
  state: StrategyState;
  failures: string[];
  /** Aggregate economics with the best fold removed, when that was computable. */
  withoutBestFold: { returnOnStake: number; pnl: number; stake: number } | null;
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

/**
 * Judge a candidate.
 *
 * `baseRate` is the return of taking every executable fill over the same folds.
 * It is required rather than optional because on this venue it moved from −2.0%
 * to +4.9% between two halves of one month, and a candidate scoring +3% in the
 * second half beat nothing at all. A comparison against zero alone would have
 * promoted at least three of the candidates in this study.
 */
export function judge(
  aggregate: Economics,
  folds: FoldEconomics[],
  baseRate: Economics | null,
  criteria: Acceptance = DEFAULT_ACCEPTANCE,
): Verdict {
  const failures: string[] = [];

  if (folds.length === 0) {
    return { state: "UNVALIDATED", failures: ["no out-of-sample folds were evaluated"], withoutBestFold: null };
  }

  if (aggregate.returnOnStake < criteria.minReturnOnStake) {
    failures.push(`return on stake ${pct(aggregate.returnOnStake)} is below the ${pct(criteria.minReturnOnStake)} floor`);
  }
  if (aggregate.windows < criteria.minWindows) {
    failures.push(`${aggregate.windows} settled windows is below the ${criteria.minWindows} required for the result to mean anything`);
  }
  const positive = folds.filter((f) => f.economics.returnOnStake >= 0).length;
  if (positive < criteria.minPositiveFolds) {
    failures.push(`only ${positive} of ${folds.length} folds were non-negative, needs ${criteria.minPositiveFolds}`);
  }
  if (aggregate.tStat < criteria.minTStat) {
    failures.push(`t = ${aggregate.tStat.toFixed(2)} on a window-clustered bootstrap, below ${criteria.minTStat}`);
  }
  if (aggregate.stake > 0 && aggregate.maxDrawdown / aggregate.stake > criteria.maxDrawdownOfStake) {
    failures.push(`drawdown ${pct(aggregate.maxDrawdown / aggregate.stake)} of stake exceeds ${pct(criteria.maxDrawdownOfStake)}`);
  }

  let withoutBestFold: Verdict["withoutBestFold"] = null;
  if (folds.length >= 2) {
    const best = folds.reduce((a, b) => (b.economics.pnl > a.economics.pnl ? b : a));
    const rest = folds.filter((f) => f !== best);
    const stake = rest.reduce((s, f) => s + f.economics.stake, 0);
    const pnl = rest.reduce((s, f) => s + f.economics.pnl, 0);
    withoutBestFold = { stake, pnl, returnOnStake: stake > 0 ? pnl / stake : 0 };
    if (criteria.survivesBestFoldRemoval && withoutBestFold.returnOnStake < criteria.minReturnOnStake) {
      failures.push(
        `removing the best fold takes it from ${pct(aggregate.returnOnStake)} to ${pct(withoutBestFold.returnOnStake)} — the result is one period, not a strategy`,
      );
    }
  }

  // A candidate that IS the base rate cannot be asked to beat itself.
  if (criteria.mustBeatBaseRate && baseRate && baseRate !== aggregate) {
    if (aggregate.returnOnStake <= baseRate.returnOnStake) {
      failures.push(
        `${pct(aggregate.returnOnStake)} does not beat taking every available fill (${pct(baseRate.returnOnStake)}), so the selection adds nothing`,
      );
    }
  } else if (criteria.mustBeatBaseRate && !baseRate) {
    failures.push("no base-rate comparison was supplied, so the selection cannot be shown to add anything");
  }

  return { state: failures.length === 0 ? "VALIDATED" : "REJECTED", failures, withoutBestFold };
}
