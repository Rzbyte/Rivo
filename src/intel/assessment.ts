// What a price means, stated as a rule rather than an opinion.
//
// Every label below is a deterministic function of numbers on the screen. That
// constraint is doing real work: a product that says OVERCONFIDENT has made a
// claim about somebody's money, and the only defensible version of that claim is
// one a reader can recompute from the same inputs and arrive at the same word.
//
// These labels are DESCRIPTIVE. None of them is BUY, SELL, or a mispricing
// claim. A market can be overconfident and untradeable at the same time — the
// spread eats the gap, the depth is not there, or the sample behind the
// historical comparison is three windows. Turning a description into an
// instruction is the strategy layer's job, and it has a gate in front of it.

/** Ordered by how much they should worry a reader, most first. */
export type AssessmentCode =
  | "INSUFFICIENT_SAMPLE"
  | "LOW_LIQUIDITY"
  | "HIGH_SPREAD"
  | "LARGE_DISAGREEMENT"
  | "OVERCONFIDENT"
  | "UNDERCONFIDENT"
  | "WELL_CALIBRATED";

export interface Assessment {
  code: AssessmentCode;
  /** One sentence, in the reader's terms. */
  detail: string;
}

export interface AssessmentInput {
  /** What DreamDEX is asking for this leg, 0..1. */
  price: number;
  /** Best bid and ask, when both sides are quoted. */
  bid: number | null;
  ask: number | null;
  /** Shares available at or better than the reference. */
  depth: number;
  /** Rivo's own probability for this leg, when it could be computed. */
  reference: number | null;
  /**
   * How often comparable contracts settled true, and how many independent
   * settled windows that is based on. Null when there is no comparable set.
   */
  historical: { realized: number; windows: number } | null;
}

/** The thresholds, in one place, so a label cannot drift from its own rule. */
export const RULES = {
  /** Below this many settled windows, the historical comparison says nothing. */
  minWindows: 30,
  /** Shares available before depth stops being a caveat. */
  minDepth: 5,
  /** Spread above this is the dominant fact about the price. */
  maxSpread: 0.04,
  /** |reference − price| above this is a disagreement worth naming. */
  largeGap: 0.08,
  /** |realized − quoted| within this counts as calibrated. */
  calibrated: 0.03,
} as const;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/**
 * Assess one leg.
 *
 * Order matters and encodes precedence: a caveat about the DATA outranks a claim
 * about the price, because a claim computed from three windows or quoted across
 * a nine-point spread is not a claim about the market — it is a claim about the
 * sample or the book.
 */
export function assess(input: AssessmentInput): Assessment {
  const { price, bid, ask, depth, reference, historical } = input;
  const spread = bid !== null && ask !== null ? ask - bid : null;

  if (!historical || historical.windows < RULES.minWindows) {
    return {
      code: "INSUFFICIENT_SAMPLE",
      detail: historical
        ? `Only ${historical.windows} comparable settled window${historical.windows === 1 ? "" : "s"} — too few to say whether this price is right.`
        : "No comparable settled contracts yet, so there is nothing to check this price against.",
    };
  }

  if (depth < RULES.minDepth) {
    return {
      code: "LOW_LIQUIDITY",
      detail: `Only ${depth.toFixed(1)} share${depth === 1 ? "" : "s"} available at this price. Whatever the number says, you may not be able to act on it.`,
    };
  }

  if (spread !== null && spread > RULES.maxSpread) {
    return {
      code: "HIGH_SPREAD",
      detail: `${pct(spread)} between bid and ask. Crossing it costs more than most disagreements are worth.`,
    };
  }

  // Over- and under-confidence are about distance from a coin flip, not about
  // direction. A market quoting 0.80 that settles 0.70, and one quoting 0.20
  // that settles 0.30, are the same error: both were further from 0.5 than the
  // outcomes justified.
  const gap = historical.realized - price;
  const towardCertainty = price >= 0.5 ? -gap : gap;

  if (Math.abs(gap) <= RULES.calibrated) {
    return {
      code: "WELL_CALIBRATED",
      detail: `Contracts priced near ${pct(price)} settled true ${pct(historical.realized)} of the time across ${historical.windows} windows. The price is doing its job.`,
    };
  }

  if (reference !== null && Math.abs(reference - price) >= RULES.largeGap) {
    return {
      code: "LARGE_DISAGREEMENT",
      detail: `Rivo's model says ${pct(reference)} against the market's ${pct(price)}. A gap that size is worth understanding before it is worth trading.`,
    };
  }

  return towardCertainty > 0
    ? {
        code: "OVERCONFIDENT",
        detail: `The market quotes ${pct(price)}; comparable contracts settled true ${pct(historical.realized)} of the time. It is claiming more certainty than the outcomes have supported.`,
      }
    : {
        code: "UNDERCONFIDENT",
        detail: `The market quotes ${pct(price)}; comparable contracts settled true ${pct(historical.realized)} of the time. It is hedging more than the outcomes have required.`,
      };
}

/** For badges. Neutral, caution, or a claim about the price. */
export const ASSESSMENT_TONE: Record<AssessmentCode, "neutral" | "caution" | "claim"> = {
  INSUFFICIENT_SAMPLE: "neutral",
  LOW_LIQUIDITY: "caution",
  HIGH_SPREAD: "caution",
  LARGE_DISAGREEMENT: "claim",
  OVERCONFIDENT: "claim",
  UNDERCONFIDENT: "claim",
  WELL_CALIBRATED: "neutral",
};

export const ASSESSMENT_LABEL: Record<AssessmentCode, string> = {
  INSUFFICIENT_SAMPLE: "Insufficient sample",
  LOW_LIQUIDITY: "Low liquidity",
  HIGH_SPREAD: "High spread",
  LARGE_DISAGREEMENT: "Large disagreement",
  OVERCONFIDENT: "Overconfident",
  UNDERCONFIDENT: "Underconfident",
  WELL_CALIBRATED: "Well calibrated",
};
