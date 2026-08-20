// Maker mode: quote both sides instead of crossing the spread.
//
// WHY THIS EXISTS. The taker backtest is unambiguous — buying into this venue's
// flow loses at every threshold tested, and the live run agrees. But the loss
// has a shape: we pay the spread and then pay the winner's curse on top. A maker
// is on the other side of both. The question is whether that is enough, and no
// replay can answer it: crediting ourselves with a fill requires knowing we
// would have been at the front of a queue that no longer exists.
//
// WHAT MAKES IT PLAUSIBLE HERE, mechanically rather than hopefully:
//
//   * Complete sets. One unit of collateral mints 1 Up + 1 Down. Sell the Up at
//     your ask and the Down at 1 - your bid and you receive 1 + (ask - bid)
//     against the 1 you spent. The settlement outcome cancels — by expiry you
//     hold neither leg.
//   * Zero fees on maker, taker and settlement, so the spread is not handed
//     back. On a fee venue this trade does not exist.
//
// WHAT MAKES IT UNCERTAIN, and why nothing here promises a profit:
//
//   * Fills arrive ONE SIDE AT A TIME. A maker who sells only the Up leg is left
//     holding the Down leg — a directional position it never chose. Inventory
//     risk is the whole game.
//   * The side that fills is the side that was wrong. That is adverse selection,
//     and it is what kills most market makers.
//
// The kit's own ec-maker has the plumbing and says so plainly: its fair value is
// "deliberately simple — the mid of the current YES book... swap in your own
// signal to actually make money." Rivo is that signal. And unlike ec-maker,
// inventory here is a POSITION, so the portfolio delta budget governs it.

import type { Leg } from "../engine/book.js";
import type { Opportunity } from "../engine/opportunity.js";
import type { RiskProfile } from "../portfolio/profiles.js";

export interface Quote {
  marketId: string;
  asset: string;
  intervalSec: number;
  /** Leg being quoted. Prices are in this leg's own probability terms. */
  leg: Leg;
  side: "buy" | "sell";
  price: number;
  size: number;
  /** Model value of the leg, for the log and for measuring capture afterwards. */
  fair: number;
  /** Why this quote is the size it is. */
  binding: string;
}

export interface MakerParams {
  /** Half the spread quoted either side of fair value, in probability. */
  halfSpread: number;
  /** Shares per quote before caps. */
  quoteSize: number;
  /**
   * Refuse to quote when the model and the book disagree by more than this.
   *
   * A large gap means one of them has the question or the inputs wrong, and a
   * maker quoting through it is not earning a spread — it is taking a view, and
   * a view is exactly what the taker backtest showed does not pay. This is
   * ec-oracle-follow's OF_MAX_DISAGREEMENT, and the taker sweep showed the cost
   * of not having it: losses grew monotonically with claimed edge.
   */
  maxDisagreement: number;
  /** Never quote inside this much of expiry — the venue can lock mid-flight. */
  minSecondsLeft: number;
  /** Collateral available to back new inventory. */
  freeCash: number;
  /** Per-asset directional budget, as collateral per 1% move. */
  assetDeltaBudget: number;
}

export interface MakerInputs {
  opportunities: Opportunity[];
  /** Current signed delta per asset, from the portfolio risk engine. */
  assetDelta: Map<string, number>;
  /** Shares currently held, keyed `marketId:LEG`. */
  inventory: Map<string, number>;
  profile: RiskProfile;
  params: MakerParams;
  now: number;
}

export interface MakerPlan {
  quotes: Quote[];
  /** Markets needing a minted complete set before their ask can rest. */
  needsInventory: { marketId: string; shares: number; reason: string }[];
  skipped: { marketId: string; leg: Leg; reason: string }[];
}

/**
 * Key for a leg. Lower-cased deliberately: market ids arrive from the indexer in
 * one case and from the SDK in another, and a mismatch here is silent — the
 * inventory lookup misses, the ask never rests, and the maker re-mints a
 * complete set every single cycle while believing it holds nothing.
 */
export const legKey = (marketId: string, leg: Leg): string => `${marketId.toLowerCase()}:${leg}`;

/**
 * Decide what to quote this cycle.
 *
 * Pure: takes a snapshot and returns intentions. That keeps the interesting part
 * — how wide, how big, when to stand aside — testable without a venue, a signer
 * or a clock.
 */
export function planQuotes(input: MakerInputs): MakerPlan {
  const { params: p, profile, now } = input;
  const quotes: Quote[] = [];
  const needsInventory: MakerPlan["needsInventory"] = [];
  const skipped: MakerPlan["skipped"] = [];

  // One entry per market, priced from the UP leg. The DOWN leg is its
  // complement, so quoting both legs independently would double the inventory
  // requirement for the same economic position.
  const byMarket = new Map<string, Opportunity>();
  for (const o of input.opportunities) {
    if (o.leg !== "UP") continue;
    if (!Number.isFinite(o.fair)) continue;
    byMarket.set(o.marketId, o);
  }

  for (const o of byMarket.values()) {
    const secondsLeft = o.expiry - now;
    if (secondsLeft < p.minSecondsLeft) {
      skipped.push({ marketId: o.marketId, leg: "UP", reason: `${Math.round(secondsLeft)}s to expiry` });
      continue;
    }

    // Disagreement ceiling, measured against whatever the book will show us.
    const reference = o.mid ?? o.ask;
    if (reference !== null && Math.abs(o.fair - reference) > p.maxDisagreement) {
      skipped.push({
        marketId: o.marketId,
        leg: "UP",
        reason: `model ${o.fair.toFixed(3)} vs book ${reference.toFixed(3)} — beyond the ${p.maxDisagreement} ceiling`,
      });
      continue;
    }

    // Clamping to (0,1) can eat a side's spread without eating the other's. On a
    // leg worth 0.999 the ask clamps back to 0.999 and sells at exactly fair,
    // capturing nothing while still carrying the risk — a guard that only checks
    // ask > bid waves that through. Each side is therefore checked on its own,
    // and a side that keeps less than half its intended edge is not quoted.
    const bidPx = clamp(o.fair - p.halfSpread);
    const askPx = clamp(o.fair + p.halfSpread);
    const minEdge = p.halfSpread / 2;
    const bidViable = o.fair - bidPx >= minEdge;
    const askViable = askPx - o.fair >= minEdge;
    if (!bidViable && !askViable) {
      skipped.push({ marketId: o.marketId, leg: "UP", reason: "spread does not fit inside (0,1) on either side" });
      continue;
    }

    // --- the bid: buying UP costs collateral and adds positive delta ---------
    const held = input.inventory.get(legKey(o.marketId, "UP")) ?? 0;
    const deltaPerShare = deltaPer1Pct(o);
    const existing = input.assetDelta.get(o.asset) ?? 0;
    let bidSize = p.quoteSize;
    let bidBinding = "quote size";

    const cashCap = p.freeCash / Math.max(bidPx, 1e-6);
    if (cashCap < bidSize) {
      bidSize = cashCap;
      bidBinding = "free cash";
    }
    if (Math.abs(deltaPerShare) > 1e-12) {
      // A filled bid moves this asset's delta up. Only quote what the budget can
      // absorb: an inventory position is a position, and the portfolio does not
      // stop caring about exposure because it arrived passively.
      const room = Math.max(0, (p.assetDeltaBudget - existing) / deltaPerShare);
      if (room < bidSize) {
        bidSize = room;
        bidBinding = `${o.asset} delta budget`;
      }
    }
    bidSize = floorToLot(bidViable ? bidSize : 0);
    if (bidSize > 0) {
      quotes.push({ ...meta(o), leg: "UP", side: "buy", price: bidPx, size: bidSize, fair: o.fair, binding: bidBinding });
    } else {
      skipped.push({
        marketId: o.marketId,
        leg: "UP",
        reason: bidViable ? `bid sized to zero by ${bidBinding}` : "bid clamped against 0 — no edge left to capture",
      });
    }

    // --- the ask: selling UP needs UP in hand -------------------------------
    // There is no naked short here. Without inventory the ask cannot rest, and
    // a one-sided maker is just a slow buyer.
    const askSize = floorToLot(askViable ? Math.min(p.quoteSize, held) : 0);
    if (askSize > 0) {
      quotes.push({ ...meta(o), leg: "UP", side: "sell", price: askPx, size: askSize, fair: o.fair, binding: "inventory held" });
    } else if (!askViable) {
      skipped.push({ marketId: o.marketId, leg: "UP", reason: "ask clamped against 1 — would sell at fair, capturing nothing" });
    } else {
      needsInventory.push({
        marketId: o.marketId,
        shares: p.quoteSize,
        reason: "no UP inventory — mint a complete set so the ask can rest",
      });
    }
  }

  void profile;
  return { quotes, needsInventory, skipped };
}

const meta = (o: Opportunity) => ({ marketId: o.marketId, asset: o.asset, intervalSec: o.intervalSec });
const clamp = (p: number): number => Math.min(0.999, Math.max(0.001, p));

/**
 * The venue's lot is coarser than ec-core configures — measured, a size of
 * 9.749193… reverts where 3.71 fills. Round down so a quote is never rejected
 * for a reason no error message will name.
 */
const LOT_STEPS = Number(process.env.RIVO_LOT_STEPS ?? 100);
const floorToLot = (n: number): number => Math.floor(Math.max(0, n) * LOT_STEPS) / LOT_STEPS;

/** Collateral gained per 1% rise in the underlying, per share of the UP leg. */
function deltaPer1Pct(o: Opportunity): number {
  // deltaPerShare is dP/dS; scaling by spot puts every asset on one axis. Spot
  // is recoverable from the opportunity's own moneyness and reference, but the
  // scan already folded it into deltaPerShare, so use it directly.
  return o.deltaPerShare;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** One fill against a quote we posted, as the chain recorded it. */
export interface MakerFill {
  at: number;
  marketId: string;
  leg: Leg;
  side: "buy" | "sell";
  price: number;
  size: number;
  /** Model value at the time the quote was posted. */
  fairAtQuote: number;
}

export interface MakerMetrics {
  ordersPosted: number;
  ordersRejected: number;
  fills: number;
  filledShares: number;
  /** Shares where a buy and a sell in the same market offset — the clean case. */
  pairedShares: number;
  /** Shares left one-sided, carrying directional risk to settlement. */
  oneSidedShares: number;
  /** Spread captured against our own fair value, per share. */
  capturedSpreadPerShare: number;
  /**
   * Where the model moved after we were filled, per share, signed so that
   * negative means the fill was on the wrong side. This is adverse selection.
   */
  adverseSelectionPerShare: number;
  maxInventoryShares: number;
  executionFailures: number;
}

/**
 * Score what actually happened.
 *
 * Captured spread and adverse selection are reported SEPARATELY on purpose. A
 * maker profits only when the first exceeds the second (Glosten–Milgrom), and
 * collapsing them into one P&L number hides which side of that inequality the
 * strategy is on — which is the only thing worth knowing.
 */
export function scoreFills(fills: MakerFill[], fairNow: Map<string, number>): MakerMetrics {
  let filledShares = 0;
  let captured = 0;
  let adverse = 0;
  const net = new Map<string, number>();

  for (const f of fills) {
    filledShares += f.size;
    // Selling above fair, or buying below it, is spread captured.
    const edge = f.side === "sell" ? f.price - f.fairAtQuote : f.fairAtQuote - f.price;
    captured += edge * f.size;

    const now = fairNow.get(legKey(f.marketId, f.leg));
    if (now !== undefined) {
      // A sell hurts when the model rises afterwards; a buy hurts when it falls.
      const move = f.side === "sell" ? f.fairAtQuote - now : now - f.fairAtQuote;
      adverse += move * f.size;
    }
    const k = legKey(f.marketId, f.leg);
    net.set(k, (net.get(k) ?? 0) + (f.side === "buy" ? f.size : -f.size));
  }

  let paired = 0;
  let oneSided = 0;
  let maxInv = 0;
  for (const v of net.values()) {
    oneSided += Math.abs(v);
    maxInv = Math.max(maxInv, Math.abs(v));
  }
  paired = Math.max(0, filledShares - oneSided);

  return {
    ordersPosted: 0,
    ordersRejected: 0,
    fills: fills.length,
    filledShares,
    pairedShares: paired,
    oneSidedShares: oneSided,
    capturedSpreadPerShare: filledShares > 0 ? captured / filledShares : 0,
    adverseSelectionPerShare: filledShares > 0 ? adverse / filledShares : 0,
    maxInventoryShares: maxInv,
    executionFailures: 0,
  };
}
