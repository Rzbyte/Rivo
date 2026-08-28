// Six strategies that are not Rivo's, so the central claim stops being about Rivo.
//
// `docs/ALPHA-RESEARCH.md` establishes that Rivo's own model forecasts well and
// trades badly. That is one strategy, and one strategy failing is a fact about
// that strategy. The question a builder arriving at this venue actually has is
// wider — *does anything simple clear the spread here?* — and it cannot be
// answered by a sample of one.
//
// So these run alongside `rivo-v1` in the shadow pass, against the same live
// contracts, resolved against the same settlements. They are deliberately
// SIMPLE: each one is a rule a person would try in their first hour, and each
// tests a different hypothesis about where an edge might be.
//
// THIS IS NOT A LEADERBOARD. `docs/submission/judge-faq.md` refuses ranking,
// prizes and a social layer, and that stands — DreamDEX runs Algo Arena for
// competition and it is scored on volume. What comes out of these is a
// DISTRIBUTION published as evidence, with a sample size and an interval on
// every row, and `coin-flip` on it as the null hypothesis.
//
// ONE SIZING RULE FOR ALL OF THEM, on purpose. Every baseline that enters asks
// for the same fraction of the notional it is allowed. The comparison is then
// about the ENTRY RULE and nothing else — a baseline that sized cleverly would
// be two hypotheses wearing one name, and the result would not attribute.

import { skip, type AgentDecision, type EventContext } from "./agent.js";

/** What every entering baseline asks for. Rivo clamps it either way. */
const STAKE_FRACTION = 0.5;

const enter = (ctx: EventContext, probability: number | null, reason: string): AgentDecision => ({
  action: "ENTER",
  probability,
  confidence: null,
  notional: ctx.limits.maxNotional * STAKE_FRACTION,
  reason,
});

/**
 * A deterministic coin, from the window and the leg.
 *
 * Seeded rather than random so the null hypothesis is reproducible: re-running
 * the study over the same settled contracts has to give the same answer, or the
 * baseline that exists to be a control becomes a source of variance itself.
 * FNV-1a over `marketId:leg` — small, no dependency, and well spread.
 */
export function coinOf(marketId: string, leg: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${marketId}:${leg}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

export interface Baseline {
  slug: string;
  label: string;
  /** The hypothesis this one is on the board to test. */
  question: string;
  decide: (ctx: EventContext) => AgentDecision;
}

export const BASELINES: readonly Baseline[] = [
  {
    slug: "favourite",
    label: "Favourite",
    question: "Does buying the side the book already believes work?",
    // The naive retail reflex, and the one `docs/EVIDENCE.md` §3 predicts loses
    // most: the favourite is expensive precisely because it is likely.
    decide: (ctx) => {
      const ask = ctx.price.ask;
      if (ask === null) return skip("nothing offered on this leg");
      if (ask <= 0.5) return skip(`ask ${ask.toFixed(3)} is not the favourite`);
      return enter(ctx, ask, `favourite at ${ask.toFixed(3)}`);
    },
  },
  {
    slug: "longshot",
    label: "Longshot",
    question: "Do cheap tickets pay for themselves?",
    decide: (ctx) => {
      const ask = ctx.price.ask;
      if (ask === null) return skip("nothing offered on this leg");
      if (ask >= 0.2) return skip(`ask ${ask.toFixed(3)} is not a longshot`);
      return enter(ctx, ask, `longshot at ${ask.toFixed(3)}`);
    },
  },
  {
    slug: "coin-flip",
    label: "Coin flip",
    question: "What does no information at all return?",
    // The control. Its expected return is the negative of the spread it crosses,
    // so it measures the cost of participating — which is the number every other
    // row on the study has to beat before any of them mean anything.
    decide: (ctx) => {
      if (ctx.price.ask === null) return skip("nothing offered on this leg");
      const coin = coinOf(ctx.market.marketId, ctx.market.leg);
      if (coin < 0.5) return skip(`coin ${coin.toFixed(3)} said no`);
      return enter(ctx, null, `coin ${coin.toFixed(3)} said yes`);
    },
  },
  {
    slug: "spread-aware",
    label: "Spread aware",
    question: "Is the edge recoverable by only trading cheap books?",
    // `docs/EVIDENCE.md` §3 finds taking liquidity negative at every threshold.
    // If the cause is transaction cost rather than the forecast, restricting to
    // tight, deep books should recover it. If it does not, the cost was not the
    // reason.
    decide: (ctx) => {
      const { bid, ask, depth } = ctx.price;
      if (ask === null) return skip("nothing offered on this leg");
      if (bid === null) return skip("no bid, so the spread cannot be measured");
      const spread = ask - bid;
      if (spread > 0.03) return skip(`spread ${spread.toFixed(3)} too wide`);
      if (depth < 20) return skip(`depth ${depth.toFixed(0)} too thin`);
      return enter(ctx, ask, `spread ${spread.toFixed(3)}, depth ${depth.toFixed(0)}`);
    },
  },
  {
    slug: "late-entry",
    label: "Late entry",
    question: "Does the phase effect survive the spread?",
    // The sharpest of the six. `docs/evidence/calibration.json` measures AUC by
    // phase at 0.603 → 0.697 → 0.810 → 0.894 → 0.936: a window is dramatically
    // more predictable near expiry. Whether that predictability is TRADEABLE is
    // a different question, because the book knows it too and prices move to the
    // extremes where a spread costs proportionally most.
    decide: (ctx) => {
      const ask = ctx.price.ask;
      if (ask === null) return skip("nothing offered on this leg");
      const elapsed = 1 - ctx.market.secondsLeft / ctx.market.intervalSec;
      if (elapsed < 0.8) return skip(`only ${(elapsed * 100).toFixed(0)}% through the window`);
      return enter(ctx, ask, `${(elapsed * 100).toFixed(0)}% through the window`);
    },
  },
  {
    slug: "high-conviction",
    label: "High conviction",
    question: "Does demanding more edge help, or is the winner's curse real?",
    // Rivo's own signal at a much higher floor than production's 0.03.
    // `docs/ALPHA-RESEARCH.md` measures losses GROWING with claimed edge —
    // selecting the leg that maximises `model − price` selects for the leg where
    // the model's own error is largest. If that is right, this should be worse
    // than `rivo-v1`, not better, and being wrong about it is worth knowing.
    decide: (ctx) => {
      const p = ctx.reference.probability;
      const ask = ctx.price.ask;
      if (p === null) return skip("no reference probability for this window");
      if (ask === null) return skip("nothing offered on this leg");
      const edge = p - ask;
      if (edge < 0.1) return skip(`edge ${edge >= 0 ? "+" : ""}${edge.toFixed(3)} below floor 0.100`);
      return enter(ctx, p, `edge +${edge.toFixed(3)} against ask ${ask.toFixed(3)}`);
    },
  },
];

export const baselineBySlug = (slug: string): Baseline | undefined =>
  BASELINES.find((b) => b.slug === slug);
