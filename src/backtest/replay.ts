// Liquidity-grounded backtest.
//
// The kit's own backtester builds a synthetic book from OHLCV candles. That is
// the right call for spot, and the wrong one here: it would let a strategy fill
// any size at any price it fancied on a venue whose real problem is that most
// windows never trade at all. Sizing against imaginary depth is how a backtest
// produces a number that evaporates on contact with the book.
//
// So this replays against FILLS THAT ACTUALLY EXECUTED. Every opportunity in the
// stream below is a moment when a counterparty demonstrably existed, at that
// price, for at least that size. Rivo is only ever allowed to take the other
// side of a trade that really happened.
//
// The comparison that matters is not Rivo against buy-and-hold. It is Rivo
// against the SAME forecasts sized without portfolio constraints — because if
// the constraints do not earn their keep, the whole portfolio layer is decoration.

import type { Asset } from "../core/config.js";
import { Indexer, scaleReference, type MarketRow } from "../core/indexer.js";
import { ASSETS } from "../core/config.js";
import { fairValue, clampProbability } from "../model/fairvalue.js";
import { sigmaPerMinute, type Bar } from "../model/vol.js";
import { legDelta } from "../engine/opportunity.js";
import { deltaPer1Pct } from "../portfolio/risk.js";
import type { RiskProfile } from "../portfolio/profiles.js";
import type { Leg } from "../engine/book.js";
import { DEFAULT_VOL_LOOKBACK_MIN } from "../calibration/dataset.js";

/** A moment at which Rivo could have taken one side of a real trade. */
export interface Chance {
  at: number;
  marketId: string;
  asset: Asset;
  intervalSec: number;
  expiry: number;
  leg: Leg;
  /** Price Rivo would have paid for this leg. */
  price: number;
  /** Shares that actually changed hands — the honest size cap. */
  size: number;
  fair: number;
  edge: number;
  /** Collateral P&L per 1% underlying move, per share. */
  deltaPer1PctPerShare: number;
  /** 1 if this leg paid out, 0 if it expired worthless. */
  won: 0 | 1;
  /** Which side the resting order was on: `BUY_YES` | `SELL_YES`. */
  makerSide: string;
  /** Shares that actually changed hands in this fill. */
  fillSize: number;
  /**
   * Seconds between the bar our spot came from and the fill we are pricing
   * against. Minute bars mean this is routinely 60-120s — enough for the
   * underlying to have moved before we ever see it, which manufactures apparent
   * edge on exactly the trades that were triggered by that move.
   */
  spotLagSec: number;
}

export interface BuildChancesOptions {
  days?: number;
  cadences?: number[];
  volLookbackMin?: number;
  /** Skip a taker's own side: we can only take liquidity that was resting. */
  minSize?: number;
  /** Emit both legs of every fill, not just the one the model calls cheap. */
  keepAllLegs?: boolean;
  onProgress?: (m: string) => void;
}

class BarIndex {
  private readonly byMinute = new Map<number, number>();
  constructor(readonly bars: Bar[]) {
    for (let i = 0; i < bars.length; i++) this.byMinute.set(Math.floor(bars[i]!.t / 60), i);
  }
  /** Last bar FULLY CLOSED at `sec` — never the one still forming. */
  at(sec: number): number {
    let m = Math.floor((sec - 60) / 60);
    for (let back = 0; back < 30; back++, m--) {
      const i = this.byMinute.get(m);
      if (i !== undefined) return i;
    }
    return -1;
  }
}

export async function buildChances(idx: Indexer, o: BuildChancesOptions = {}): Promise<{ chances: Chance[]; markets: number; withFills: number }> {
  const log = o.onProgress ?? (() => {});
  const lookback = o.volLookbackMin ?? DEFAULT_VOL_LOOKBACK_MIN;
  const cadences = o.cadences ?? [900, 3600, 14400, 86400];
  const since = Math.floor(Date.now() / 1000) - (o.days ?? 30) * 86_400;

  log("fetching settled markets…");
  const all = await idx.settledMarkets({ sinceExpiry: since });
  const markets = all.filter(
    (m) =>
      !m.voided &&
      (m.winningOutcome === 0 || m.winningOutcome === 1) &&
      ASSETS.includes(m.asset) &&
      cadences.some((c) => Math.abs(m.intervalSec - c) <= Math.max(2, c * 0.01)) &&
      m.tradeCount > 0,
  );
  log(`  ${markets.length} settled windows that actually traded (of ${all.length})`);
  if (markets.length === 0) return { chances: [], markets: all.length, withFills: 0 };

  log("fetching fills…");
  const fills = await idx.fills(markets.map((m) => m.marketId));
  const totalFills = [...fills.values()].reduce((n, l) => n + l.length, 0);
  log(`  ${totalFills} fills across ${fills.size} windows`);

  log("resolving opening references…");
  const refs = await idx.openingReferences(markets.map((m) => m.marketId));

  const from = Math.min(...markets.map(startOf));
  const to = Math.max(...markets.map((m) => m.expiry));
  const bars = new Map<Asset, BarIndex>();
  for (const asset of ASSETS) {
    if (!markets.some((m) => m.asset === asset)) continue;
    log(`fetching ${asset} candles…`);
    bars.set(asset, new BarIndex(await idx.candles(asset, from - lookback * 60 - 60, to + 120)));
  }

  const chances: Chance[] = [];
  let withFills = 0;
  for (const m of markets) {
    const list = fills.get(m.marketId.toLowerCase());
    if (!list || list.length === 0) continue;
    const index = bars.get(m.asset);
    const raw = refs.get(m.marketId.toLowerCase());
    if (!index || raw === undefined) continue;
    const start = startOf(m);
    const openIdx = index.at(start);
    if (openIdx < 0) continue;
    const reference = scaleReference(raw, index.bars[openIdx]!.close);
    if (reference === null) continue;
    withFills++;

    const upWon: 0 | 1 = m.winningOutcome === 0 ? 1 : 0;

    for (const f of list) {
      if (f.size < (o.minSize ?? 0.5)) continue;
      const i = index.at(f.at);
      if (i < 0) continue;
      const spot = index.bars[i]!.close;
      // The bar is stamped with its START; it closed 60s later. Lag is measured
      // from the close, which is the newest information that bar contains.
      const spotLagSec = Math.max(0, f.at - (index.bars[i]!.t + 60));
      const sigma = sigmaPerMinute(index.bars, i, lookback);
      if (sigma === null) continue;
      const tau = (m.expiry - f.at) / 60;
      if (tau <= 0) continue;
      const fv = fairValue({ spot, reference, sigmaPerMin: sigma, tauMinutes: tau });
      if (!fv) continue;

      // A trade at price p means BOTH sides were available: someone paid p for
      // Up, so the Down leg was simultaneously obtainable at 1 - p. Rivo picks
      // whichever leg its model says is cheap, or neither.
      for (const leg of ["UP", "DOWN"] as const) {
        const price = leg === "UP" ? f.price : 1 - f.price;
        const fair = clampProbability(leg === "UP" ? fv.pUp : 1 - fv.pUp);
        const edge = fair - price;
        // Both legs are emitted. The taker view filters to edge > 0; the maker
        // view needs the EXPENSIVE leg, which is the one that filter discards.
        if (!o.keepAllLegs && edge <= 0) continue;
        chances.push({
          at: f.at,
          marketId: m.marketId,
          asset: m.asset,
          intervalSec: m.intervalSec,
          expiry: m.expiry,
          leg,
          price,
          size: f.size,
          fair,
          edge,
          deltaPer1PctPerShare: deltaPer1Pct(legDelta(leg, spot, fv.z, fv.sigmaRemaining), spot),
          won: leg === "UP" ? upWon : ((1 - upWon) as 0 | 1),
          spotLagSec,
          makerSide: f.makerSide,
          fillSize: f.size,
        });
      }
    }
  }
  chances.sort((a, b) => a.at - b.at);
  return { chances, markets: all.length, withFills };
}

const startOf = (m: MarketRow): number => (m.tradingStart > 0 ? m.tradingStart : m.expiry - (m.intervalSec || 900));

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export interface Trade {
  at: number;
  marketId: string;
  asset: Asset;
  leg: Leg;
  shares: number;
  price: number;
  cost: number;
  expiry: number;
  won: 0 | 1;
  deltaPer1PctPerShare: number;
}

export interface RunResult {
  name: string;
  trades: Trade[];
  finalEquity: number;
  startEquity: number;
  /** Peak-to-trough as a fraction of the running peak. */
  maxDrawdown: number;
  hitRate: number;
  totalStaked: number;
  /** Realised profit divided by everything ever staked. */
  returnOnStake: number;
  /** How often a positive-edge chance was declined. */
  declined: number;
  taken: number;
}

export interface Sizer {
  name: string;
  /**
   * Stake for one chance, in collateral. Receives the live portfolio so a rule
   * can refuse concentration; returns 0 to decline.
   */
  size(c: Chance, s: SimState): number;
}

export interface SimState {
  equity: number;
  cash: number;
  open: Trade[];
  profile: RiskProfile;
  rho: number;
}

/**
 * Run one sizing rule over the shared opportunity stream.
 *
 * Every rule sees identical chances in identical order, so any difference in the
 * result is the rule, not the sample.
 */
export function run(name: string, chances: Chance[], sizer: Sizer, profile: RiskProfile, rho: number, startEquity: number): RunResult {
  const state: SimState = { equity: startEquity, cash: startEquity, open: [], profile, rho };
  const trades: Trade[] = [];
  let peak = startEquity;
  let maxDrawdown = 0;
  let declined = 0;
  let totalStaked = 0;

  for (const c of chances) {
    settleDue(state, c.at, trades);

    const stake = sizer.size(c, state);
    if (!(stake > 0)) {
      declined++;
      continue;
    }
    // Never take more than actually changed hands, and never more than the cash.
    const affordable = Math.min(stake, state.cash);
    const shares = Math.min(affordable / c.price, c.size);
    const cost = shares * c.price;
    if (!(cost > 0) || shares <= 0) {
      declined++;
      continue;
    }
    const t: Trade = {
      at: c.at,
      marketId: c.marketId,
      asset: c.asset,
      leg: c.leg,
      shares,
      price: c.price,
      cost,
      expiry: c.expiry,
      won: c.won,
      deltaPer1PctPerShare: c.deltaPer1PctPerShare,
    };
    state.cash -= cost;
    state.open.push(t);
    totalStaked += cost;

    peak = Math.max(peak, state.equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - state.equity) / peak : 0);
  }
  settleDue(state, Number.POSITIVE_INFINITY, trades);

  const wins = trades.filter((t) => t.won === 1).length;
  return {
    name,
    trades,
    startEquity,
    finalEquity: state.equity,
    maxDrawdown,
    hitRate: trades.length > 0 ? wins / trades.length : 0,
    totalStaked,
    returnOnStake: totalStaked > 0 ? (state.equity - startEquity) / totalStaked : 0,
    declined,
    taken: trades.length,
  };
}

/** Redeem everything that has settled by `now`. Winners pay 1 per share. */
function settleDue(s: SimState, now: number, sink: Trade[]): void {
  const still: Trade[] = [];
  for (const t of s.open) {
    if (t.expiry <= now) {
      s.cash += t.won === 1 ? t.shares : 0;
      sink.push(t);
    } else still.push(t);
  }
  s.open = still;
  s.equity = s.cash + s.open.reduce((n, t) => n + t.cost, 0);
}
