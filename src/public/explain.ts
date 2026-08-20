// Turn a decision into a sentence a person can act on.
//
// This is FORMATTING, not reasoning. Every number and every clause below is read
// off the allocator's own output — the constraint that bound, the collateral it
// allowed, the positions already holding the budget. Nothing is inferred, and no
// language model is involved, because an explanation that was generated rather
// than derived is not an explanation: it is a plausible sentence that happens to
// sit next to a decision, and it would keep sounding right long after it stopped
// being true.
//
// The test for every string here is the same: a user should be able to check it
// against the numbers on the same screen and find they agree.

import { tenorLabel } from "../core/venue.js";
import type { DecisionView, PortfolioView } from "./engine.js";

export interface Explanation {
  /** One line: what happened. */
  headline: string;
  /** Why, in terms of the portfolio rather than the leg. */
  detail: string;
  /** Positions currently consuming the budget that bound, when that is the reason. */
  competitors: { label: string; cost: number; delta: number }[];
  /** The binding constraint verbatim, so the engine's own words are always available. */
  raw: string;
}

const money = (n: number) => n.toFixed(2);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Which held positions are consuming the budget named by the binding constraint.
 *
 * This is the part users actually want: not "the BTC budget is full" but "it is
 * full because these two positions are in it." Both are true; only one lets them
 * decide whether they agree with the trade-off.
 */
function competitorsFor(d: DecisionView, view: PortfolioView): Explanation["competitors"] {
  const b = d.binding;
  const held = view.positions;
  const pick = (f: (p: (typeof held)[number]) => boolean) =>
    held
      .filter(f)
      .map((p) => ({ label: p.label, cost: p.cost, delta: p.shares * p.deltaPer1PctPerShare }))
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      .slice(0, 4);

  if (b.includes("delta budget") && b.startsWith(d.asset)) return pick((p) => p.asset === d.asset);
  if (b.includes("combined delta")) return pick(() => true);
  if (b.startsWith("expiry bucket")) {
    const bucket = b.slice("expiry bucket ".length).trim();
    return pick((p) => new Date(p.expiry * 1000).toISOString().slice(0, 16) >= bucket);
  }
  if (b.includes("tenor cap")) return pick((p) => p.intervalSec === d.intervalSec);
  if (b.includes("max position")) return pick((p) => p.marketId === d.marketId && p.leg === d.leg);
  return [];
}

export function explain(d: DecisionView, view: PortfolioView): Explanation {
  const b = d.binding;
  const competitors = competitorsFor(d, view);
  const edge = d.edge === null ? "no edge" : `${pct(d.edge)} raw edge`;
  const tenor = tenorLabel(d.intervalSec);

  if (d.action === "BUY") {
    const headline = `Bought ${d.shares.toFixed(2)} shares for ${money(d.cost)} collateral.`;
    if (b.startsWith("kelly")) {
      return {
        headline,
        detail:
          `Sizing was set by Kelly itself, not by a portfolio limit — at ${edge} the growth-optimal stake ` +
          `after the ${pct(view.policy.capital > 0 ? d.kellyTarget / view.policy.capital : 0)} profile haircut is ${money(d.kellyTarget)}, ` +
          `and nothing in the portfolio was tighter. This is the unconstrained case.`,
        competitors,
        raw: b,
      };
    }
    if (b.includes("book depth")) {
      return {
        headline,
        detail:
          `The portfolio would have allowed more; the book would not. Only ${d.shares.toFixed(2)} shares were resting ` +
          `at or below Rivo's fair value of ${d.fair.toFixed(3)}, and paying above fair value to fill the rest ` +
          `would have bought the remainder at negative expected value.`,
        competitors,
        raw: b,
      };
    }
    return {
      headline,
      detail:
        `Kelly asked for ${money(d.kellyTarget)} at ${edge}. The position was cut to ${money(d.cost)} by ${describeLimit(b, view)} — ` +
        `the trade is good, but this is as much of it as the portfolio can carry.`,
      competitors,
      raw: b,
    };
  }

  // --- refusals -----------------------------------------------------------
  const headline = `Skipped — ${edge}${d.ask !== null ? `, ask ${d.ask.toFixed(3)} against fair ${d.fair.toFixed(3)}` : ""}.`;

  if (b.includes("edge below")) {
    return {
      headline,
      detail:
        `The edge is real but below the ${view.policy.profile} floor of ${pct(view.limits.minEdge)}. ` +
        `Crossing a spread costs about that much twice over on this venue, so a thinner edge is a way to pay ` +
        `the book for the privilege of being right.`,
      competitors: [],
      raw: b,
    };
  }
  if (b.includes("delta budget") || b.includes("combined delta")) {
    // The budget is often consumed by an earlier tranche of THIS leg, which is a
    // materially different thing to explain than a rival position taking it:
    // one means "you already own this idea", the other means "something outbid it".
    const self = competitors.filter((c) => c.label === d.label);
    const rivals = competitors.filter((c) => c.label !== d.label);
    const who =
      self.length > 0 && rivals.length === 0
        ? ` Rivo's own position in this leg is what fills it — ${money(self[0]!.cost)} collateral at ${self[0]!.delta.toFixed(2)} per 1% move — so this is a leg already sized to the limit, not one that lost out.`
        : rivals.length > 0
          ? ` It is held by ${rivals.map((c) => c.label).join(" and ")}, which scored higher per unit of exposure consumed.`
          : "";
    return {
      headline,
      detail:
        `${describeLimit(b, view)} is already at its limit, so there is no room for this leg regardless of its edge.${who} ` +
        `Every window here is a bet on the same two underlyings, so a second position in the same direction is not ` +
        `diversification — it is the same bet at a different horizon.`,
      competitors,
      raw: b,
    };
  }
  if (b.includes("below minimum trade")) {
    // Distinguish "nearly at target" from "a genuine but uneconomic sliver".
    // Reading the figure out of the engine's own string keeps the two sentences
    // anchored to the same number the raw line shows.
    const room = Number(b.match(/top-up of ([\d.]+)/)?.[1] ?? 0);
    const floor = Number(b.match(/minimum trade ([\d.]+)/)?.[1] ?? 0);
    return {
      headline,
      detail:
        room < floor * 0.05
          ? `This leg is already at the size Rivo wants it. Kelly names a target for the WHOLE position, so what ` +
            `is held counts against it — there is ${money(room)} of room left, and topping that up would pay a ` +
            `round trip to move essentially nothing.`
          : `The portfolio allows ${money(room)} more here, which is below the ${money(floor)} minimum trade. ` +
            `Crossing a spread twice to deploy that much would cost more than the edge on it is worth.`,
      competitors,
      raw: b,
    };
  }
  if (b.includes("no depth")) {
    return {
      headline,
      detail:
        `Nothing is resting at or below Rivo's fair value of ${d.fair.toFixed(3)}. The edge exists on paper and ` +
        `there is no size behind it, which on a book this thin is the common case.`,
      competitors: [],
      raw: b,
    };
  }
  if (b.includes("no positive edge") || b.includes("not a candidate")) {
    return {
      headline: `Not a candidate — the book is at or through Rivo's fair value of ${d.fair.toFixed(3)}.`,
      detail: `Rivo prices every live leg whether or not it wants it. Most of the venue is fairly priced most of the time, and this ${tenor} leg is.`,
      competitors: [],
      raw: b,
    };
  }
  if (b.includes("cash floor") || b.includes("free cash")) {
    return {
      headline,
      detail:
        `Deployable cash is exhausted. The ${view.policy.profile} profile holds ${money(view.limits.cashFloor)} of capital back ` +
        `permanently, so a drawdown never forces a sale into a thin bid to fund the next idea.`,
      competitors,
      raw: b,
    };
  }
  if (b.includes("deployed cap")) {
    return {
      headline,
      detail: `Total deployed capital is at its ceiling of ${money(view.limits.deployedCap)}. Further edge has to wait for something to settle.`,
      competitors,
      raw: b,
    };
  }
  if (b.startsWith("expiry bucket")) {
    return {
      headline,
      detail:
        `Too much capital already settles in the same 15-minute window. Positions that resolve together fail together, ` +
        `so this is concentration in time rather than in direction.`,
      competitors,
      raw: b,
    };
  }
  if (b.includes("tenor cap")) {
    return {
      headline,
      detail:
        `You capped ${tenor} exposure at ${money(view.limits.tenorCaps.find((t) => t.intervalSec === d.intervalSec)?.cap ?? 0)} collateral, ` +
        `and it is full. This is your own limit, not a profile default.`,
      competitors,
      raw: b,
    };
  }
  if (b.includes("max position")) {
    return {
      headline,
      detail: `This leg is already at its per-position ceiling of ${money(view.limits.perPositionCap)}. Rivo sizes the WHOLE leg to a target, so what is held counts against it rather than every cycle asking for a fresh full stake.`,
      competitors,
      raw: b,
    };
  }
  if (b.includes("no book or spot")) {
    return {
      headline: "Skipped — not priceable right now.",
      detail: `Either the book is empty or the spot reading is stale. A stalled feed reads as certainty to a volatility model, so Rivo refuses to price against one.`,
      competitors: [],
      raw: b,
    };
  }
  return { headline, detail: describeLimit(b, view), competitors, raw: b };
}

/** Restate an engine constraint name as a portfolio-level noun phrase. */
function describeLimit(b: string, view: PortfolioView): string {
  if (b.includes("combined delta")) return `combined BTC+ETH exposure, correlated at rho ${view.rho.toFixed(2)}`;
  if (b.includes("delta budget")) return `${b.slice(0, 3)} directional exposure`;
  if (b.startsWith("kelly")) return "the Kelly stake itself";
  if (b.startsWith("expiry bucket")) return "capital settling in one 15-minute bucket";
  if (b.includes("max position")) return "the per-position ceiling";
  if (b.includes("deployed cap")) return "the deployed-capital ceiling";
  if (b.includes("free cash")) return "deployable cash above the cash floor";
  if (b.includes("tenor cap")) return "your tenor cap";
  return b;
}
