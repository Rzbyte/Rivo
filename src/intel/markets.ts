// Live Event Contract intelligence.
//
// Thin on purpose. `src/engine/scan.ts::snapshot` already discovers live
// windows, pulls the resting orders, prices both legs and reports what it could
// not price — that is the market data layer, and it has been in production for
// weeks. What this adds is the part the venue cannot show you: whether prices
// like this one have historically meant what they said.
//
// Nothing here decides anything. A card can say OVERCONFIDENT and that is a
// description of the historical record, not an instruction; the strategy layer
// is somewhere else and has a gate in front of it.

import type { Snapshot } from "../engine/scan.js";
import type { Opportunity } from "../engine/opportunity.js";
import type { Asset } from "../core/config.js";
import type { Leg } from "../engine/book.js";
import { assess, type Assessment } from "./assessment.js";
import { lookupCohort, cohortLabel, type CalibrationReport, type Cohort } from "./calibration.js";

export interface MarketCard {
  marketId: string;
  asset: Asset;
  leg: Leg;
  intervalSec: number;
  /** Unix seconds at settlement. */
  expiry: number;
  /** Seconds left. Negative is possible between expiry and settlement. */
  secondsLeft: number;

  /** What DreamDEX asks for this leg right now. Null when nothing is offered. */
  price: number | null;
  bid: number | null;
  ask: number | null;
  /** ask − bid, when both sides are quoted. */
  spread: number | null;
  /** Shares available at or better than Rivo's own probability. */
  depth: number;

  /** Rivo's probability for this leg. Null when it could not be computed. */
  reference: number | null;
  /** reference − price. The disagreement, signed toward Rivo. */
  gap: number | null;

  /**
   * How often comparable contracts settled true, and on how many independent
   * settled windows. Null when no bucket covers this price.
   */
  historical: {
    realized: number; windows: number; lo95: number; hi95: number; thin: boolean;
    /** Which comparable set produced this number, and how it is described. */
    cohort: Cohort; cohortLabel: string;
    /** True when a more specific cohort existed but had too few windows to use. */
    fellBack: boolean;
    /**
     * The probability band this contract's price fell into.
     *
     * Without it the realized rate is unattached: a reader sees "settled 3.3%"
     * beside a price of 0.02 and cannot tell whether 3.3% is the rate for
     * contracts quoted near 0.02 or for the cohort as a whole. It is the former,
     * and saying so is the difference between a measurement and a decoration.
     */
    bucket: { lo: number; hi: number };
    /** When the answering cohort was measured. A rate with no date range cannot be checked. */
    from: number | null;
    to: number | null;
  } | null;

  assessment: Assessment;
}

export interface MarketsView {
  at: number;
  cards: MarketCard[];
  /** Windows the engine could not price, and why. Shown rather than dropped. */
  unpriced: { marketId: string; reason: string }[];
  /** The global cohort's provenance. Null when nothing has been computed. */
  calibration: { windows: number; from: number; to: number; basis: string } | null;
  /** How many cohorts were available to fall back through. */
  cohorts: number;
}

/**
 * The most specific comparable set that can honestly answer for this price.
 *
 * "Historical realized 61%" is worthless unless the reader can find out what 61%
 * is the realized rate OF, so the cohort travels with the number and the card
 * says when it had to widen.
 */
function historicalFor(
  reports: Map<string, CalibrationReport>,
  asset: string,
  intervalSec: number,
  price: number,
): MarketCard["historical"] {
  const hit = lookupCohort(reports, asset, intervalSec, price);
  if (!hit.bucket) return null;
  const b = hit.bucket;
  return {
    realized: b.realized, windows: b.windows, lo95: b.lo95, hi95: b.hi95, thin: b.thin,
    cohort: hit.cohort, cohortLabel: cohortLabel(hit.cohort), fellBack: hit.fellBack,
    bucket: { lo: b.lo, hi: b.hi },
    from: hit.period?.from ?? null,
    to: hit.period?.to ?? null,
  };
}

/**
 * Turn a live snapshot into cards a person can read.
 *
 * `calibration` is passed in rather than computed here because computing it
 * means fetching a month of fills, which is a background job's work and not a
 * page load's. A null report is a supported state: every card then says
 * INSUFFICIENT_SAMPLE, which is true.
 */
export function marketsView(
  snap: Snapshot,
  /** Every stored cohort, keyed by `cohortKey`. Empty is a supported state. */
  calibration: Map<string, CalibrationReport>,
  now = snap.at,
): MarketsView {
  const cards = snap.opportunities.map((o: Opportunity): MarketCard => {
    const price = o.ask;
    const historical = price === null ? null : historicalFor(calibration, o.asset, o.intervalSec, price);
    const spread = o.bid !== null && o.ask !== null ? o.ask - o.bid : null;
    const reference = Number.isFinite(o.fair) ? o.fair : null;
    return {
      marketId: o.marketId,
      asset: o.asset,
      leg: o.leg,
      intervalSec: o.intervalSec,
      expiry: o.expiry,
      secondsLeft: o.expiry - now,
      price,
      bid: o.bid,
      ask: o.ask,
      spread,
      depth: o.depthAtFair,
      reference,
      gap: price !== null && reference !== null ? reference - price : null,
      historical,
      assessment:
        price === null
          ? {
              code: "LOW_LIQUIDITY" as const,
              detail: "Nothing is offered on this leg right now, so there is no price to assess.",
            }
          : assess({
              price,
              bid: o.bid,
              ask: o.ask,
              depth: o.depthAtFair,
              reference,
              historical: historical ? { realized: historical.realized, windows: historical.windows } : null,
            }),
    };
  });

  return {
    at: now,
    cards: cards.sort((a, b) => a.secondsLeft - b.secondsLeft),
    unpriced: snap.unpriced.map((u) => ({ marketId: u.marketId, reason: u.reason })),
    calibration: (() => {
      const g = calibration.get("*:*");
      return g ? { windows: g.windows, from: g.from, to: g.to, basis: g.basis } : null;
    })(),
    cohorts: calibration.size,
  };
}
