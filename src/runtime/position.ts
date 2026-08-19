// The position manager.
//
// `ec-oracle-follow`'s README names this exact gap: "Position management proper
// — conviction-based sizing, a hysteresis band wide enough to cover the ~0.024
// round-trip cost on a 2-cent book, mark-to-market, a stop — is deliberately not
// here yet... that's the seam where exits would go." This is that seam.
//
// The hard part is not deciding that a position has gone wrong. It is deciding
// that acting on it is worth more than the spread it costs to act. On a 2-cent
// book a round trip is ~0.024, so a manager that reacts to every wobble converts
// a positive-expectancy book into a machine for donating spread. Every action
// below is therefore gated on the improvement EXCEEDING the cost of taking it.
//
// One mechanic constrains the whole design: you cannot reverse a position by
// buying the other leg. That mints a complete set — the legs cancel, the
// collateral locks until expiry, and a spread was paid on each side to get
// nowhere. Reducing risk means SELLING what is held, which needs a resting bid.

import { bestBid, type Leg, type MarketBook } from "../engine/book.js";
import type { Opportunity } from "../engine/opportunity.js";
import { headroomSec } from "../engine/opportunity.js";
import type { RiskProfile } from "../portfolio/profiles.js";
import type { HeldPosition } from "./state.js";

export type PositionAction = "HOLD" | "REDUCE" | "EXIT" | "RECOVER";

export interface PositionDecision {
  position: HeldPosition;
  action: PositionAction;
  /** Shares to sell (REDUCE/EXIT) or pairs to merge (RECOVER). */
  size: number;
  /** Worst acceptable price when selling. */
  limitPrice: number;
  reason: string;
  /** Model value of the leg now, versus what we paid. */
  fairNow: number | null;
  /** What the book would actually pay to take it off our hands. */
  bidNow: number | null;
  /** Mark-to-model profit per share. */
  markToModel: number | null;
}

export interface ManageInputs {
  positions: HeldPosition[];
  /** Unix seconds of the last trade in each leg, keyed `marketId:leg`. */
  lastTradedAt?: Record<string, number>;
  /** Minimum gap between actions on one leg. */
  cooldownSec?: number;
  /** Current scoring for every live leg, keyed `marketId:leg`. */
  opportunities: Map<string, Opportunity>;
  books: Map<string, MarketBook>;
  profile: RiskProfile;
  now: number;
}

export const legKey = (marketId: string, leg: Leg): string => `${marketId}:${leg}`;

/**
 * Decide what to do with everything currently held.
 *
 * RECOVER is evaluated first and separately because it is not a risk decision at
 * all. Holding equal Up and Down in one window is already directionally flat —
 * the offsetting part carries no exposure, it is just collateral locked until
 * expiry earning nothing. Merging it back needs no counterparty and pays no
 * spread, so it is close to free money and should never wait behind a spread
 * decision.
 */
export function manage(input: ManageInputs): PositionDecision[] {
  const { positions, opportunities, books, profile, now } = input;
  const cooldown = input.cooldownSec ?? 180;
  const out: PositionDecision[] = [];

  // --- RECOVER: offsetting legs in the same window -------------------------
  const byMarket = new Map<string, HeldPosition[]>();
  for (const p of positions) {
    const list = byMarket.get(p.marketId) ?? [];
    list.push(p);
    byMarket.set(p.marketId, list);
  }
  const recovered = new Set<HeldPosition>();
  for (const [, list] of byMarket) {
    const up = list.filter((p) => p.leg === "UP").reduce((n, p) => n + p.shares, 0);
    const down = list.filter((p) => p.leg === "DOWN").reduce((n, p) => n + p.shares, 0);
    const pairs = Math.min(up, down);
    if (pairs <= 0) continue;
    for (const p of list) {
      recovered.add(p);
      out.push({
        position: p,
        action: "RECOVER",
        size: Math.min(pairs, p.shares),
        limitPrice: 1,
        reason: `${pairs.toFixed(2)} offsetting pairs held — merge returns collateral now instead of at expiry, no counterparty, no spread`,
        fairNow: null,
        bidNow: null,
        markToModel: null,
      });
    }
  }

  // --- HOLD / REDUCE / EXIT ------------------------------------------------
  for (const p of positions) {
    if (recovered.has(p)) continue;
    const opp = opportunities.get(legKey(p.marketId, p.leg));
    const book = books.get(p.marketId);
    const bid = book ? bestBid(book[p.leg]) : null;
    const fair = opp && Number.isFinite(opp.fair) ? opp.fair : null;
    const markToModel = fair === null ? null : fair - p.entryPrice;

    const hold = (reason: string): PositionDecision => ({
      position: p,
      action: "HOLD",
      size: 0,
      limitPrice: 0,
      reason,
      fairNow: fair,
      bidNow: bid,
      markToModel,
    });

    // Windows leave the live list the moment they lock. Nothing to do but wait
    // for settlement and claim — which is the loop's job, not ours.
    if (!opp) {
      out.push(hold("window no longer live — awaiting settlement"));
      continue;
    }

    // The venue can lock a market between our snapshot and our send, so every
    // strategy in the kit stops acting a fraction of the window before expiry.
    // Inside that band a position is a settlement bet whether we like it or not.
    const secsLeft = p.expiry - now;
    if (secsLeft <= headroomSec(p.intervalSec)) {
      out.push(hold(`inside expiry headroom (${Math.max(0, Math.round(secsLeft))}s left) — holding to settlement`));
      continue;
    }

    if (fair === null) {
      out.push(hold("no fair value this cycle"));
      continue;
    }

    // One action per leg per cooldown. Without this a conviction stop re-fires
    // every cycle on the SAME model move, halving the position again and again
    // and paying a spread each time — measured live: 3.06 -> 1.53 -> 0.76 -> 0.38
    // across four cycles, all of it triggered by one 0.078 drop.
    const sinceTraded = now - (input.lastTradedAt?.[legKey(p.marketId, p.leg)] ?? 0);
    if (sinceTraded < cooldown) {
      out.push(hold(`acted on this leg ${sinceTraded}s ago — cooling down`));
      continue;
    }

    // Exiting costs the spread twice over: we bought at the ask and would sell
    // into the bid. Compare the model's verdict against that cost, not against
    // zero, or the manager will trade itself broke being right.
    if (bid === null) {
      out.push(hold("no bid — cannot exit even if we wanted to"));
      continue;
    }
    const exitProceeds = bid;
    const holdValue = fair;
    const improvement = exitProceeds - holdValue;

    if (improvement > profile.rotationHysteresis) {
      out.push({
        position: p,
        action: "EXIT",
        size: p.shares,
        limitPrice: bid,
        reason:
          `book bids ${bid.toFixed(3)} for a leg the model now values at ${fair.toFixed(3)} — ` +
          `selling beats holding by ${improvement.toFixed(3)}, clear of the ${profile.rotationHysteresis} round-trip band`,
        fairNow: fair,
        bidNow: bid,
        markToModel,
      });
      continue;
    }

    // A conviction stop: the model has moved decisively against the position.
    // Sized as a multiple of the round-trip so it cannot fire on noise, and
    // still only acted on when the bid makes acting worthwhile.
    //
    // Measured from `fairAtEntry`, which the loop RESETS after every action.
    // Measuring from the original entry forever would mean one bad move keeps
    // firing the stop until the position is gone, which is not a stop, it is a
    // slow forced liquidation at the bid.
    const conviction = fair - p.fairAtEntry;
    if (conviction < -2 * profile.rotationHysteresis && bid > 0) {
      const half = p.shares / 2;
      out.push({
        position: p,
        action: "REDUCE",
        size: half,
        limitPrice: Math.max(0.001, bid),
        reason:
          `model fell ${Math.abs(conviction).toFixed(3)} since entry (${p.fairAtEntry.toFixed(3)} -> ${fair.toFixed(3)}) — ` +
          `halving rather than exiting, because the bid at ${bid.toFixed(3)} still under-pays the model`,
        fairNow: fair,
        bidNow: bid,
        markToModel,
      });
      continue;
    }

    out.push(
      hold(
        `model ${fair.toFixed(3)} vs entry ${p.entryPrice.toFixed(3)}, bid ${bid.toFixed(3)} — ` +
          `selling would give up ${(holdValue - exitProceeds).toFixed(3)} of model value`,
      ),
    );
  }

  return out;
}

/**
 * Would rotating out of `held` into `candidate` pay for itself?
 *
 * There is no atomic rotate on this venue — it is an exit and an entry, paying
 * spread on both. So the replacement has to be better by MORE than that round
 * trip, not merely better. This is the check that stops the allocator churning
 * between two legs of the same underlying every cycle.
 */
export function rotationPays(
  held: { fairNow: number; bidNow: number },
  candidate: { fair: number; ask: number },
  profile: RiskProfile,
): { pays: boolean; gain: number; cost: number } {
  const exitGiveUp = held.fairNow - held.bidNow; // model value surrendered on the way out
  const entryEdge = candidate.fair - candidate.ask; // edge acquired on the way in
  const holdEdge = 0; // the held leg's edge is already banked at its entry price
  const gain = entryEdge - holdEdge;
  const cost = exitGiveUp + profile.rotationHysteresis;
  return { pays: gain > cost, gain, cost };
}
