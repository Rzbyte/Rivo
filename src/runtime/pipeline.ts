// The checks every decision passes, whichever side of the signer it ends on.
//
// Shadow used to be a second, simpler path: ask an agent, write the answer down.
// It never consulted market eligibility, never normalised a size to the venue's
// lot, never saw a risk ceiling and never read the strategy gate. So it could
// record a hypothetical trade that real Rivo would have refused — and a shadow
// record of a trade that could not have happened is not weak evidence, it is
// evidence pointing the wrong way. An agent looked good in shadow precisely
// where the constraints would have stopped it.
//
// So both paths run this first, and they diverge only at the last step:
//
//     agent decision
//         ↓  schema
//         ↓  market eligibility
//         ↓  strategy state · execution mode
//         ↓  risk ceiling
//         ↓  venue normalisation
//     execution intent
//         ├── SHADOW            record hypothetical · no signer · no transaction
//         └── EXPERIMENTAL      signer → DreamDEX SDK → transaction
//
// Everything above the fork is here. Nothing here signs, reads a key, opens a
// socket or touches the database: it is a pure function of what was decided and
// what the rules are, which is what makes the two paths comparable at all.

import { modeIntendsExecution, type ExecutionMode } from "./permission.js";
import { mayExecuteLive, type StrategyState } from "../research/gating.js";

/**
 * Lot granularity actually accepted by the venue, in steps per share.
 *
 * 100 = a hundredth of a share. Deliberately coarser than the tick the venue
 * config claims, because the config's claim is what reverts: measured on one
 * market at one price, sizes of 1, 2, 3, 5 and 8 all filled and 3.71 filled,
 * while 9.749193184999303 reverted with `placeBinaryOrder reverted: for an
 * unknown reason`. In raw units 3.71 is exactly 3,710,000; 9.749193… floors to
 * 9,749,193, a multiple of nothing.
 *
 * Fractional-Kelly sizing produces the latter constantly, so this is not an edge
 * case — it is every order.
 */
export const LOT_STEPS_PER_SHARE = Number(process.env.RIVO_LOT_STEPS ?? 100);

/** Round a share count DOWN to something the venue will accept. */
export const normalizeToLot = (shares: number): number =>
  Number.isFinite(shares) && shares > 0 ? Math.floor(shares * LOT_STEPS_PER_SHARE) / LOT_STEPS_PER_SHARE : 0;

/**
 * Why a decision stopped, in terms an evidence table can group by.
 *
 * These exist so the Proof surface can distinguish "we chose not to" from "the
 * venue said no" from "the chain reverted". Before this, a size that rounded to
 * zero at the lot arrived as an EXECUTION FAILURE — indistinguishable, in the
 * counts, from a transaction that actually reverted on Somnia. Thousands of
 * them. The evidence said the system failed constantly; what it had done was
 * decline, deterministically and correctly, before sending anything.
 */
export type RefusalCode =
  | "NO_DECISION"
  | "MALFORMED_DECISION"
  | "MARKET_EXPIRED"
  | "NO_TRADEABLE_PRICE"
  | "STRATEGY_STATE_BLOCKED"
  | "MODE_BLOCKED"
  | "RISK_LIMIT"
  | "BELOW_VENUE_MINIMUM"
  | "NORMALIZED_SIZE_ZERO";

/** The stage that decided. Ordered, and the order is the pipeline. */
export const STAGES = [
  "SCHEMA",
  "ELIGIBILITY",
  "POLICY",
  "RISK",
  "VENUE",
  "INTENT",
] as const;
export type Stage = (typeof STAGES)[number];

export interface Intent {
  /**
   * SKIP  — the agent declined, or there was nothing to act on. Not a failure.
   * REFUSED — Rivo declined on the agent's behalf: policy, risk or venue size.
   * EXECUTE — everything passed; what happens next depends on the mode alone.
   */
  outcome: "SKIP" | "REFUSED" | "EXECUTE";
  stage: Stage;
  code: RefusalCode | null;
  reason: string;
  /** Venue-normalised. Zero unless EXECUTE. */
  shares: number;
  cost: number;
  price: number;
  /**
   * Whether a transaction may be signed for this intent.
   *
   * False in shadow even when everything else passed — which is the whole point:
   * the intent is identical, and the mode alone decides whether a signer sees it.
   */
  maySign: boolean;
}

export interface PreExecutionInput {
  /** What the agent or the engine decided. */
  decision: {
    action: string;
    /** Collateral the decision asked to stake. Null means it declined to size. */
    notional: number | null;
    /** The price it expects to pay. */
    price: number | null;
  };
  market: {
    expiry: number;
    /** Unix seconds. */
    now: number;
    /** Best ask, or null when the book could not be read. */
    ask: number | null;
  };
  policy: {
    mode: ExecutionMode;
    strategyState: StrategyState;
    /** Smallest trade worth paying a spread for, in collateral. */
    minTrade: number;
    /** Hard ceiling on one decision's stake. */
    maxNotional: number;
    /**
     * Set when the mode is an approved experiment rather than a validated
     * deployment, so a REJECTED strategy may still reach a testnet.
     */
    experimentApproved?: boolean;
  };
  /**
   * The allocator's verdict, when one was computed.
   *
   * Real cycles have one — it carries the delta budget, the per-position cap and
   * the cash floor. Shadow runs against live markets without a book of its own,
   * so it passes null and the ceiling below is the only risk applied. Stated
   * rather than hidden: a shadow run is not claiming to have cleared a portfolio
   * constraint it never had.
   */
  risk?: { allowedCost: number; binding: string } | null;
}

const refuse = (stage: Stage, code: RefusalCode, reason: string): Intent => ({
  outcome: "REFUSED", stage, code, reason, shares: 0, cost: 0, price: 0, maySign: false,
});

const skip = (stage: Stage, code: RefusalCode, reason: string): Intent => ({
  outcome: "SKIP", stage, code, reason, shares: 0, cost: 0, price: 0, maySign: false,
});

/**
 * Everything between a decision and a signer.
 *
 * Pure and total: it never throws, never awaits and never reads the environment
 * beyond the lot constant. Both callers get the same answer for the same inputs,
 * which is the property the equivalence tests assert.
 */
export function preExecution(input: PreExecutionInput): Intent {
  const { decision, market, policy } = input;

  // --- SCHEMA -------------------------------------------------------------
  // An agent that says nothing is not an error and must not be recorded as one.
  const action = String(decision.action ?? "").toUpperCase();
  if (action === "SKIP" || action === "HOLD" || action === "" || action === "NONE") {
    return skip("SCHEMA", "NO_DECISION", "the agent declined to act");
  }
  if (action !== "BUY") {
    return refuse("SCHEMA", "MALFORMED_DECISION", `unrecognised action ${JSON.stringify(decision.action)}`);
  }
  if (decision.notional !== null && !(Number.isFinite(decision.notional) && decision.notional >= 0)) {
    return refuse("SCHEMA", "MALFORMED_DECISION", "notional is not a finite non-negative number");
  }

  // --- ELIGIBILITY --------------------------------------------------------
  // A contract at or past its expiry cannot be entered. Checked before policy so
  // an expired market reads as an expired market rather than as a gate refusal.
  if (!(market.expiry > market.now)) {
    return skip("ELIGIBILITY", "MARKET_EXPIRED", "the contract has reached expiry");
  }
  const price = decision.price ?? market.ask;
  if (price === null || !(price > 0) || !(price < 1)) {
    return skip("ELIGIBILITY", "NO_TRADEABLE_PRICE", "no ask inside (0, 1) to buy at");
  }

  // --- POLICY -------------------------------------------------------------
  // The strategy gate, in the terms this pipeline can see. It is deliberately
  // NOT the whole permission check — signer, network and delegation are decided
  // in permission.ts and re-checked at the executor, because those are facts
  // about a deployment rather than about a decision. What belongs here is the
  // part shadow must obey too: a strategy nobody validated does not get to
  // produce hypothetical trades that look like a validated one's.
  const validated = mayExecuteLive(policy.strategyState);
  const experimenting = policy.mode === "experimental_testnet" && policy.experimentApproved === true;
  if (modeIntendsExecution(policy.mode) && !validated && !experimenting) {
    return refuse(
      "POLICY",
      "STRATEGY_STATE_BLOCKED",
      `strategy is ${policy.strategyState} and this mode is not an approved experiment`,
    );
  }

  // --- RISK ---------------------------------------------------------------
  const asked = decision.notional ?? 0;
  if (!(asked > 0)) {
    return skip("RISK", "NO_DECISION", "the decision carried no size");
  }
  let budget = Math.min(asked, policy.maxNotional);
  if (input.risk) {
    if (!(input.risk.allowedCost > 0)) {
      return refuse("RISK", "RISK_LIMIT", input.risk.binding);
    }
    budget = Math.min(budget, input.risk.allowedCost);
  }
  if (!(budget > 0)) {
    return refuse("RISK", "RISK_LIMIT", "no budget remained after risk ceilings");
  }
  if (budget < policy.minTrade) {
    // Not a venue rule — Rivo's own floor, which exists because a top-up of a
    // few cents pays a round trip to move a position it had already reached.
    return refuse(
      "RISK",
      "BELOW_VENUE_MINIMUM",
      `stake ${budget.toFixed(2)} is below the minimum trade of ${policy.minTrade.toFixed(2)}`,
    );
  }

  // --- VENUE --------------------------------------------------------------
  // The step that used to happen inside the executor, after submission had
  // already been counted as an attempt.
  const shares = normalizeToLot(budget / price);
  if (shares <= 0) {
    return refuse(
      "VENUE",
      "NORMALIZED_SIZE_ZERO",
      `stake ${budget.toFixed(2)} at ${price.toFixed(3)} rounds to zero at the venue's lot of ` +
        `1/${LOT_STEPS_PER_SHARE} share`,
    );
  }
  const cost = shares * price;

  // --- INTENT -------------------------------------------------------------
  // Identical in both modes. Only `maySign` differs, and it is the mode that
  // decides — not a separate code path, not a different set of checks.
  return {
    outcome: "EXECUTE",
    stage: "INTENT",
    code: null,
    reason: input.risk?.binding ?? "within every limit",
    shares,
    cost,
    price,
    maySign: modeIntendsExecution(policy.mode),
  };
}

/** How an intent should be labelled in evidence, given the mode it ran under. */
export const intentLabel = (intent: Intent, mode: ExecutionMode): string =>
  intent.outcome !== "EXECUTE" ? intent.outcome : modeIntendsExecution(mode) ? "SUBMITTED" : "HYPOTHETICAL";
