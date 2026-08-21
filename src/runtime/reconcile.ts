// Make the chain the authority on what Rivo holds.
//
// Until now the state file was the only record of a position, which is fine
// right up to the first time the process dies between an order filling on-chain
// and that fill being written down. After that, Rivo believes it holds nothing
// and buys a second copy of everything it already owns — with real money, in a
// market where it cannot necessarily sell either copy back.
//
// The rule is simple and one-directional: the chain wins. State is a cache of
// the chain, never the other way round. Two things make that safe to apply
// automatically rather than only reporting it:
//
//   * The indexer LAGS the chain by seconds. A position opened moments ago may
//     legitimately be absent from it, so recent positions are left alone rather
//     than deleted for being invisible.
//   * A position the chain knows about but Rivo does not has no cost basis to
//     recover — nothing records what was paid. It is adopted at a stated
//     estimate and flagged, so no report can quietly present a guess as a fill.
//
// Every correction here also moves `state.contributed`, and that is not
// bookkeeping pedantry. Reconciliation is the one place where positions appear
// and vanish without a trade, so it is the one place that can break the ledger
// identity in state.ts. It did: adopting a position credited no cash but its
// eventual payout credited the full proceeds, and a live run drifted to 451.76
// of cash against 50 of allocated capital before anything noticed.

import type { Asset } from "../core/config.js";
import type { Leg } from "../engine/book.js";
import type { HeldPosition, RivoState } from "./state.js";

/** How long a position is trusted without on-chain confirmation. */
export const INDEXER_LAG_GRACE_SEC = 120;

export interface Discrepancy {
  marketId: string;
  leg: Leg;
  /** Shares Rivo thought it held. */
  stateShares: number;
  /** Shares the chain says it holds. */
  chainShares: number;
  action: "adopted" | "dropped" | "resized" | "kept-pending";
  detail: string;
  /**
   * True when this condition will keep reporting itself unchanged every cycle.
   *
   * A holding on a window that is no longer live cannot be managed, settled or
   * dropped — so it is rediscovered on every pass and reported again, forever.
   * Over a 1,005-cycle run that is thousands of identical lines burying the ones
   * that matter, which is how a decision log stops being read. The finding is
   * still returned; only its repetition is the caller's to suppress.
   */
  recurring?: boolean;
}

export interface ReconcileInput {
  state: RivoState;
  /** Live outcome balances, keyed `marketId:LEG`, in human units. */
  chain: Map<string, number>;
  /**
   * Estimated current value per share of an unknown position, keyed
   * `marketId:LEG`. Used only as the cost basis of an adopted position, and only
   * because nothing better exists — the real entry price is not recoverable.
   */
  marks?: Map<string, number>;
  /** Metadata for adopting a position Rivo has no record of. */
  meta?: Map<string, { asset: Asset; intervalSec: number; expiry: number; fair?: number }>;
  now: number;
  graceSec?: number;
}

const key = (marketId: string, leg: Leg): string => `${marketId.toLowerCase()}:${leg}`;

/**
 * Bring `state.open` into agreement with the chain.
 *
 * Mutates the state and returns what changed, so the caller can log it. Silence
 * is the wrong behaviour here: a reconciliation that quietly rewrites a
 * portfolio is indistinguishable from a bug.
 */
export function reconcile(input: ReconcileInput): Discrepancy[] {
  const { state, chain, now } = input;
  const grace = input.graceSec ?? INDEXER_LAG_GRACE_SEC;
  const out: Discrepancy[] = [];

  // Rivo can hold several lots of one leg; the chain reports one number. Compare
  // in aggregate and apply any correction proportionally across the lots.
  const byLeg = new Map<string, HeldPosition[]>();
  for (const p of state.open) {
    const k = key(p.marketId, p.leg);
    byLeg.set(k, [...(byLeg.get(k) ?? []), p]);
  }

  // --- what Rivo thinks it holds, checked against the chain -----------------
  for (const [k, lots] of byLeg) {
    const stateShares = lots.reduce((n, p) => n + p.shares, 0);
    const chainShares = chain.get(k) ?? 0;
    const [marketId, leg] = splitKey(k);

    if (approx(stateShares, chainShares)) continue;

    const youngest = Math.max(...lots.map((p) => p.openedAt));
    if (chainShares < stateShares && now - youngest < grace) {
      // Too recent to conclude anything. The indexer lags the chain by seconds
      // and deleting a position for being invisible would be the more expensive
      // mistake of the two.
      out.push({
        marketId,
        leg,
        stateShares,
        chainShares,
        action: "kept-pending",
        detail: `opened ${now - youngest}s ago, inside the ${grace}s indexer grace window`,
      });
      continue;
    }

    if (chainShares <= 0) {
      // Removing a position removes its cost from the open side of the ledger,
      // so the same value leaves `contributed` — the portfolio is managing less
      // than it was. Without this the equity curve steps up for free.
      for (const p of lots) {
        state.contributed = (state.contributed ?? 0) - p.cost;
        state.open.splice(state.open.indexOf(p), 1);
      }
      out.push({
        marketId,
        leg,
        stateShares,
        chainShares,
        action: "dropped",
        detail: `chain holds none — state claimed ${stateShares.toFixed(4)}`,
      });
      continue;
    }

    // Scale every lot by the same factor so cost basis stays proportional to the
    // shares that survived. Rewriting one lot and leaving the others would make
    // the average entry price a fiction.
    const factor = chainShares / stateShares;
    for (const p of lots) {
      const before = p.cost;
      p.shares *= factor;
      p.cost *= factor;
      // The chain disagreed about size, so value entered or left the portfolio
      // without a trade. Book the difference where it belongs rather than
      // letting the ledger absorb it silently.
      state.contributed = (state.contributed ?? 0) + (p.cost - before);
    }
    out.push({
      marketId,
      leg,
      stateShares,
      chainShares,
      action: "resized",
      detail: `scaled ${lots.length} lot(s) by ${factor.toFixed(4)} to match the chain`,
    });
  }

  // --- what the chain holds that Rivo has no record of ----------------------
  for (const [k, chainShares] of chain) {
    if (byLeg.has(k) || chainShares <= 0) continue;
    const [marketId, leg] = splitKey(k);
    const meta = input.meta?.get(k);
    if (!meta) {
      // Almost always a settled window whose payout has not been claimed, or a
      // market outside the venue Rivo trades. Reported, never adopted: a
      // position with no expiry cannot be managed or settled.
      out.push({
        marketId,
        leg,
        stateShares: 0,
        chainShares,
        action: "kept-pending",
        detail: `chain holds ${chainShares.toFixed(4)} but the window is not live — likely unclaimed or off-venue`,
        recurring: true,
      });
      continue;
    }
    const mark = input.marks?.get(k) ?? 0.5;
    // The wallet handed the portfolio an asset it never paid for. Record it as a
    // contribution, NOT as capital: risk budgets are fractions of capital, and a
    // stray token found on the wallet must never be able to raise Rivo's own
    // limits. It still consumes the delta budget, so adopting one makes the
    // allocator more conservative, never less.
    state.contributed = (state.contributed ?? 0) + chainShares * mark;
    state.open.push({
      marketId,
      asset: meta.asset,
      intervalSec: meta.intervalSec,
      leg,
      shares: chainShares,
      // ESTIMATED. Nothing on-chain records what was paid, so P&L on an adopted
      // position is only as good as this mark.
      entryPrice: mark,
      cost: chainShares * mark,
      expiry: meta.expiry,
      deltaPer1PctPerShare: 0, // recomputed by the next scan, which knows spot
      openedAt: now,
      fairAtEntry: meta.fair ?? mark,
      adopted: true,
    });
    out.push({
      marketId,
      leg,
      stateShares: 0,
      chainShares,
      action: "adopted",
      detail: `chain holds ${chainShares.toFixed(4)} Rivo had no record of — cost basis ESTIMATED at ${mark.toFixed(3)}/share`,
    });
  }

  return out;
}

/** Lot sizes are floats; a rounding difference is not a discrepancy. */
const approx = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));

function splitKey(k: string): [string, Leg] {
  const i = k.lastIndexOf(":");
  return [k.slice(0, i), k.slice(i + 1) as Leg];
}

/** One line per correction, for the operator log. */
export function describe(d: Discrepancy): string {
  return `RECONCILE ${d.action.toUpperCase()} ${d.leg} ${d.marketId.slice(-10)} — ${d.detail}`;
}
