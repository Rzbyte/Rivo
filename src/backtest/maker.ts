// Would Rivo do better providing liquidity than taking it?
//
// The taker backtest answered its own question in the negative and pointed
// straight at the counterparty: the leg Rivo declined won 56.5% of the time and
// returned +9.0% per unit staked. Somebody was collecting that, and it was the
// makers whose resting quotes got hit.
//
// On this venue their edge is structural rather than predictive, and it comes
// from two DreamDEX mechanics working together:
//
//   * COMPLETE SETS. One unit of collateral mints 1 Up + 1 Down. Sell the Up at
//     your ask and the Down at 1 - your bid and you receive
//         ask + (1 - bid) = 1 + (ask - bid)
//     against the 1 you spent. The spread is the profit and the settlement
//     outcome cancels — you hold neither leg by then.
//   * ZERO FEES. Maker, taker and settlement are all 0, so that spread is not
//     handed back. On a fee venue this trade does not exist.
//
// The catch, and the reason this needs a portfolio layer rather than a loop, is
// that fills arrive ONE SIDE AT A TIME. A maker who sells only the Up leg is left
// holding the Down leg — a directional position it never chose. Inventory risk is
// the whole game, and it is exactly what delta budgets and complete-set merges
// are for.

import type { Chance } from "./replay.js";
import type { Asset } from "../core/config.js";
import type { Leg } from "../engine/book.js";

/** One resting quote that got hit. */
export interface MakerFill {
  at: number;
  marketId: string;
  asset: Asset;
  expiry: number;
  /** The leg Rivo SOLD. */
  leg: Leg;
  /** Price Rivo received for it. */
  price: number;
  size: number;
  /** Whether that leg went on to pay out — a loss for the seller. */
  legWon: 0 | 1;
}

export interface MakerParams {
  /** Half-spread quoted either side of the model's fair value, in probability. */
  halfSpread: number;
  /** Shares per quote. */
  quoteSize: number;
  /**
   * Refuse to quote when the model and the market disagree by more than this.
   * A large gap means one of them has the question or the inputs wrong, and a
   * maker who quotes through it is not earning a spread, it is taking a view.
   */
  maxDisagreement: number;
}

export interface MakerResult {
  fills: MakerFill[];
  /** Collateral spent minting the sets that backed the quotes. */
  minted: number;
  /** Collateral received selling legs. */
  received: number;
  /** Value of inventory left over at settlement. */
  settled: number;
  pnl: number;
  /** Fills where both legs of a pair sold — the clean, risk-free case. */
  pairedFills: number;
  /** Fills that left an unhedged leg. */
  onesidedFills: number;
  quotesConsidered: number;
}

/**
 * Replay Rivo as a maker over the same executed-fill stream.
 *
 * The fill record is the evidence: a trade printed at price `p` means a taker was
 * willing to pay `p` for the Up leg. Rivo is credited with that fill only if its
 * own quote was at least as good for the taker as the one that actually filled —
 * so it never claims liquidity it would not have won, and never claims size that
 * did not trade.
 */
export function runMaker(chances: Chance[], params: MakerParams): MakerResult {
  const fills: MakerFill[] = [];
  let minted = 0;
  let received = 0;
  let quotesConsidered = 0;

  // One record per (fill, leg). Rivo quotes both legs of every window, so the
  // question for each is simply: was Rivo's quote on the side that got hit, and
  // was it good enough to have won the trade?
  for (const c of chances) {
    // `makerSide` names the side the RESTING order was on, in Up terms.
    //   SELL_YES resting  -> the taker BOUGHT Up. Rivo's Up ask was the target.
    //   BUY_YES  resting  -> the taker SOLD Up, i.e. bought Down. Rivo's Down ask
    //                        was the target, since buying Down crosses a resting
    //                        Buy-Up (mint-a-pair).
    const legHit: Leg = c.makerSide === "SELL_YES" ? "UP" : c.makerSide === "BUY_YES" ? "DOWN" : "UP";
    if (c.leg !== legHit) continue;
    quotesConsidered++;

    // A maker SELLS. Selling is only worth doing above fair value — that is the
    // spread. Rivo's ask on this leg sits a half-spread above its own forecast.
    const ask = c.fair + params.halfSpread;

    // Refuse when the model and the market are far apart: a large gap means one
    // of them has the inputs wrong, and quoting through it is taking a view
    // rather than earning a spread. This is oracle-follow's OF_MAX_DISAGREEMENT,
    // and the taker sweep showed what its absence costs.
    if (Math.abs(c.fair - c.price) > params.maxDisagreement) continue;

    // Rivo only wins the trade if its quote was at least as good for the taker
    // as the one that actually filled. Never claim liquidity it would not have won.
    if (ask > c.price) continue;

    const size = Math.min(params.quoteSize, c.fillSize);
    if (!(size > 0)) continue;

    // Backing the sale means holding the leg, which means minting a pair first:
    // 1 collateral in, 1 Up + 1 Down out. Naked shorts do not exist on this venue.
    minted += size;
    received += size * c.price;
    fills.push({
      at: c.at,
      marketId: c.marketId,
      asset: c.asset,
      expiry: c.expiry,
      leg: c.leg,
      price: c.price,
      size,
      legWon: c.won,
    });
  }

  // Settlement. Every mint left the OPPOSITE leg in inventory, redeeming for 1 if
  // it wins and 0 if not. Selling the leg that goes on to lose is the good case:
  // the leg retained is the one that pays.
  let settled = 0;
  for (const f of fills) settled += f.legWon === 1 ? 0 : f.size;

  const byMarket = new Map<string, { UP: number; DOWN: number }>();
  for (const f of fills) {
    const e = byMarket.get(f.marketId) ?? { UP: 0, DOWN: 0 };
    e[f.leg] += f.size;
    byMarket.set(f.marketId, e);
  }
  let paired = 0;
  let onesided = 0;
  for (const e of byMarket.values()) {
    paired += Math.min(e.UP, e.DOWN);
    onesided += Math.abs(e.UP - e.DOWN);
  }

  return {
    fills,
    minted,
    received,
    settled,
    pnl: received + settled - minted,
    pairedFills: paired,
    onesidedFills: onesided,
    quotesConsidered,
  };
}
