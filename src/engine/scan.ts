// Load everything the engine needs for one pass over the live venue.
//
// One snapshot per cycle, shared by every window. The kit's guidance is to keep
// the snapshot you validated and reuse it for the whole pass rather than
// re-reading mid-decision, so that a market roll between two reads cannot leave
// half the portfolio priced against one state and half against another.

import { ASSETS, type Asset } from "../core/config.js";
import { Indexer, scaleReference } from "../core/indexer.js";
import { DEFAULT_VOL_LOOKBACK_MIN } from "../calibration/dataset.js";
import type { Bar } from "../model/vol.js";
import { scoreWindow, type LiveWindow, type MarketContext, type Opportunity, type ScanOptions } from "./opportunity.js";
import { buildBook, type MarketBook } from "./book.js";

export interface AssetState {
  spot: number;
  mark: number;
  spotAgeSec: number;
  bars: Bar[];
}

export interface Snapshot {
  at: number;
  assets: Map<Asset, AssetState>;
  windows: LiveWindow[];
  books: Map<string, MarketBook>;
  opportunities: Opportunity[];
  /** Windows the indexer listed but which could not be priced, and why. */
  unpriced: { marketId: string; asset: string; intervalSec: number; reason: string }[];
}

export interface SnapshotOptions extends ScanOptions {
  volLookbackMin?: number;
}

export async function snapshot(idx: Indexer, o: SnapshotOptions = {}): Promise<Snapshot> {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const lookback = o.volLookbackMin ?? DEFAULT_VOL_LOOKBACK_MIN;
  const unpriced: Snapshot["unpriced"] = [];

  const live = await idx.liveMarkets();

  const assets = new Map<Asset, AssetState>();
  for (const asset of ASSETS) {
    if (!live.some((m) => m.asset === asset)) continue;
    const [{ spot, mark, at }, bars] = await Promise.all([
      idx.latestSpot(asset),
      idx.candles(asset, now - (lookback + 5) * 60, now + 120),
    ]);
    assets.set(asset, { spot, mark, spotAgeSec: Math.max(0, now - at), bars });
  }

  const [refs, orders] = await Promise.all([
    idx.openingReferences(live.map((m) => m.marketId)),
    idx.restingOrders(live.map((m) => m.marketId)),
  ]);

  const windows: LiveWindow[] = [];
  for (const m of live) {
    const state = assets.get(m.asset);
    if (!state) {
      unpriced.push({ marketId: m.marketId, asset: m.asset, intervalSec: m.intervalSec, reason: "no price feed for asset" });
      continue;
    }
    const raw = refs.get(m.marketId.toLowerCase());
    if (raw === undefined) {
      // Common and benign right after a roll: the opening question has been
      // asked but not yet answered. The window is simply unpriceable until it is.
      unpriced.push({ marketId: m.marketId, asset: m.asset, intervalSec: m.intervalSec, reason: "opening reference not yet resolved" });
      continue;
    }
    // Anchor the oracle's decimal scale to a price we trust for this asset.
    const reference = scaleReference(raw, state.spot);
    if (reference === null) {
      unpriced.push({ marketId: m.marketId, asset: m.asset, intervalSec: m.intervalSec, reason: `reference ${raw} fits no decimal scale near spot` });
      continue;
    }
    windows.push({
      marketId: m.marketId,
      asset: m.asset,
      intervalSec: m.intervalSec,
      tradingStart: m.tradingStart > 0 ? m.tradingStart : m.expiry - (m.intervalSec || 900),
      expiry: m.expiry,
      reference,
      orders: orders.get(m.marketId.toLowerCase()) ?? [],
    });
  }

  const books = new Map<string, MarketBook>();
  const opportunities: Opportunity[] = [];
  for (const w of windows) {
    const state = assets.get(w.asset)!;
    books.set(w.marketId, buildBook(w.orders));
    const ctx: MarketContext = {
      spot: state.spot,
      spotAgeSec: state.spotAgeSec,
      bars: state.bars,
      volLookbackMin: lookback,
    };
    opportunities.push(...scoreWindow(w, ctx, { ...o, now }));
  }

  return { at: now, assets, windows, books, opportunities, unpriced };
}
