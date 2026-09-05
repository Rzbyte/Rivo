// What a price means, in one sentence a person would say out loud.
//
// Pure and separate from the page on purpose. This is the only logic on the
// consumer surface that can be WRONG rather than merely ugly, and it was:
// the first version mapped OVERCONFIDENT straight to "the book is asking too
// much", which is inverted for every contract priced under 0.5 — one leg of
// every pair on this venue. A component is awkward to test; this is not.

import { RULES, type AssessmentCode } from "@rivo/intel/assessment.js";

/** The fields a verdict is computed from. The page passes a whole card. */
export interface VerdictInput {
  price: number | null;
  spread: number | null;
  depth: number;
  reference: number | null;
  historical: { realized: number; windows: number } | null;
  assessment: { code: AssessmentCode };
}

const pct = (x: number | null, d = 0) => (x === null ? "—" : `${(x * 100).toFixed(d)}%`);

export interface Verdict {
  /** The line in the largest type on the page. */
  headline: string;
  /** One sentence under it. Never an instruction. */
  detail: string;
  tone: "good" | "under" | "over" | "caveat";
}

/**
 * The verdict, derived from the same assessment the dense surface renders.
 *
 * The mapping is deliberately one-to-one with `AssessmentCode` rather than a
 * second opinion computed here — two surfaces that describe the same contract
 * differently is exactly the failure this product was built to catch, and it
 * would be the more embarrassing one for happening inside it.
 *
 * A caveat outranks a claim. If the sample is thin, the book is wide or the
 * depth is not there, that is the answer — the calibration comparison is not
 * shown as the headline underneath a warning, because a reader takes the
 * biggest number on the screen and leaves.
 */
export function verdict(c: VerdictInput): Verdict {
  const h = c.historical;
  const quoted = c.price;

  switch (c.assessment.code) {
    case "INSUFFICIENT_SAMPLE":
      return {
        headline: "Not enough history to say",
        detail:
          h === null
            ? "No comparable contract has settled at this price yet. The honest answer is that nobody knows."
            : `Only ${h.windows} comparable ${h.windows === 1 ? "contract has" : "contracts have"} settled at this price — under the ${RULES.minWindows} this product requires before it will call anything.`,
        tone: "caveat",
      };
    case "LOW_LIQUIDITY":
      return {
        headline: "Almost nothing is on offer",
        detail: `${c.depth.toFixed(0)} shares are available at this price. Whether it is fair matters less than whether you could get filled.`,
        tone: "caveat",
      };
    case "HIGH_SPREAD":
      return {
        headline: "The spread costs more than the edge",
        detail: `A round trip at this price — in and straight back out — costs ${pct(c.spread, 1)}. That gap is the dominant fact about this contract, whatever the history says.`,
        tone: "caveat",
      };
    case "LARGE_DISAGREEMENT":
      return {
        headline: "Rivo's model disagrees sharply",
        detail: `The book asks ${pct(quoted)} and Rivo's own model says ${pct(c.reference)}. A disagreement this size is worth knowing about — and Rivo's model is one this product has already refused to trade.`,
        tone: "caveat",
      };
    // OVERCONFIDENT and UNDERCONFIDENT are statements about CERTAINTY, not about
    // direction: both mean the price sat further from — or nearer to — 0.5 than
    // the outcomes justified. A leg quoted at 0.20 that settles 0.30 is
    // overconfident, and it is also being sold too cheaply.
    //
    // So the headline is taken from the sign of realized − price, which is the
    // question a reader actually has, and the engine's word is kept in the
    // sentence under it so the two surfaces cannot be read as disagreeing. The
    // first version of this page mapped the label straight to "asking too much"
    // and was therefore inverted for every contract priced under 0.5 — which on
    // this venue is half of them, one leg of every pair.
    case "OVERCONFIDENT":
    case "UNDERCONFIDENT": {
      const realized = h?.realized ?? null;
      const cheap = realized !== null && quoted !== null && realized > quoted;
      const certainty =
        c.assessment.code === "OVERCONFIDENT"
          ? "claiming more certainty than the outcomes have supported"
          : "hedging more than the outcomes have required";
      return {
        headline: cheap ? "The book is asking too little" : "The book is asking too much",
        detail: `Contracts priced in this band settled true ${pct(realized)} of the time, and you are being asked for ${pct(quoted)}. The market is ${certainty}.`,
        tone: cheap ? "under" : "over",
      };
    }
    case "WELL_CALIBRATED":
    default:
      return {
        headline: "This price is honest",
        detail: `Contracts priced near ${pct(quoted)} settled true ${pct(h?.realized ?? null)} of the time. The price is doing its job.`,
        tone: "good",
      };
  }
}
