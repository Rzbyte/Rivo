// Build the calibration dataset: replay every settled Event Contract window,
// price it from the underlying at several points in its life, and pair each
// forecast with what settlement actually decided.
//
// Nothing here needs a key, a signer, or the SDK. That is deliberate — the whole
// point of this harness is that a reader can rerun it and get our numbers.

import { Indexer, scaleReference, type MarketRow } from "../core/indexer.js";
import { ASSETS, type Asset } from "../core/config.js";
import { fairValue } from "../model/fairvalue.js";
import { sigmaPerMinute, type Bar } from "../model/vol.js";
import type { Prediction } from "./metrics.js";

/** Where in a window's life to price it, as a fraction of elapsed time. */
export const DEFAULT_SAMPLE_POINTS = [0.1, 0.25, 0.5, 0.75, 0.9];

/** Minutes of history used to measure volatility. */
export const DEFAULT_VOL_LOOKBACK_MIN = 240;

/**
 * The cadences DreamDEX actually lists: 15m, 1h, 4h, 1d.
 *
 * The indexer also carries historical series at 56-60s and ~5m from earlier
 * venue configurations. Those are not the product — no such window has been
 * listed since the current grid settled — and they are where a diffusion model
 * breaks down: over sixty seconds the horizon is shorter than the volatility
 * measurement is meaningful over, so the model reports 0.02 on outcomes that
 * settle UP a third of the time. Calibrating against them would be measuring a
 * regime Rivo will never trade.
 *
 * They are excluded by default and reported separately, never silently dropped.
 */
export const TRADEABLE_CADENCES = [900, 3600, 14400, 86400] as const;

/**
 * Series drift by a second or two between windows (898s, 899s, 3598s rows all
 * exist), so cadence matching is by proximity rather than equality.
 */
const withinTolerance = (actual: number, target: number): boolean =>
  Math.abs(actual - target) <= Math.max(2, target * 0.01);

/** Retired cadences that ran long enough to be worth naming in the skip report. */
const RETIRED_SERIES = [60, 300] as const;

export interface Sample extends Prediction {
  marketId: string;
  asset: Asset;
  intervalSec: number;
  /** Fraction of the window elapsed when this forecast was made. */
  phase: number;
  /** Minutes remaining at forecast time. */
  tauMinutes: number;
  /** Unix seconds at which this window settled — the axis a temporal split uses. */
  settleAt: number;
  spot: number;
  reference: number;
  sigmaPerMin: number;
  z: number;
}

export interface BuildOptions {
  /** Only replay windows expiring after this unix second. */
  sinceExpiry?: number;
  /** Cap on settled markets pulled. */
  maxMarkets?: number;
  samplePoints?: number[];
  volLookbackMin?: number;
  /**
   * Cadences to include, in seconds. Defaults to {@link TRADEABLE_CADENCES}.
   * Pass an empty array to include every series the indexer carries.
   */
  cadences?: number[];
  /**
   * Restrict to windows that actually traded.
   *
   * Only about 3% of settled windows ever see a fill, so "the model is accurate"
   * and "the model is accurate where Rivo could act" are different claims. This
   * flag is what tells them apart.
   */
  tradedOnly?: boolean;
  onProgress?: (msg: string) => void;
}

export interface Dataset {
  samples: Sample[];
  /** Markets that survived every filter and produced at least one forecast. */
  marketsUsed: number;
  marketsTotal: number;
  skipped: Record<string, number>;
  from: number;
  to: number;
}

/** Fast minute-bucket lookup into an ascending bar series. */
class BarIndex {
  private readonly byMinute = new Map<number, number>();
  constructor(readonly bars: Bar[]) {
    for (let i = 0; i < bars.length; i++) this.byMinute.set(Math.floor(bars[i]!.t / 60), i);
  }

  /**
   * The last bar that had FULLY CLOSED at `sec`, or -1.
   *
   * The minus-60 is the whole point. A bar stamped `bucketStart = t` closes at
   * `t + 60`, so the bar containing the sample instant carries up to a minute of
   * the future in its close. Reading it would leak the answer into the forecast
   * — worst exactly where it matters most, since a 15m window sampled at 90% has
   * only 90 seconds left and that minute is most of the remaining uncertainty.
   *
   * Walks back up to 30 minutes for feed gaps.
   */
  at(sec: number): number {
    let m = Math.floor((sec - 60) / 60);
    for (let back = 0; back < 30; back++, m--) {
      const i = this.byMinute.get(m);
      if (i !== undefined) return i;
    }
    return -1;
  }
}

export async function buildDataset(idx: Indexer, opts: BuildOptions = {}): Promise<Dataset> {
  const log = opts.onProgress ?? (() => {});
  const samplePoints = opts.samplePoints ?? DEFAULT_SAMPLE_POINTS;
  const lookback = opts.volLookbackMin ?? DEFAULT_VOL_LOOKBACK_MIN;
  const cadences = opts.cadences ?? [...TRADEABLE_CADENCES];

  log("fetching settled markets…");
  let markets = await idx.settledMarkets({ limit: opts.maxMarkets, sinceExpiry: opts.sinceExpiry });
  const marketsTotal = markets.length;
  log(`  ${marketsTotal} settled windows on venue ${idx.venueId.slice(0, 10)}…`);

  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);

  markets = markets.filter((m) => {
    if (m.voided) return skip("voided"), false;
    if (m.winningOutcome !== 0 && m.winningOutcome !== 1) return skip("no outcome"), false;
    if (!ASSETS.includes(m.asset)) return skip("unknown asset"), false;
    if (cadences.length > 0 && !cadences.some((c) => withinTolerance(m.intervalSec, c))) {
      // Bucket the long tail of one-off series so the skip report stays readable:
      // the venue has emitted dozens of single-window cadences (467s, 32054s, ...)
      // during reconfiguration, and listing each by name buries the real reasons.
      const bucket = RETIRED_SERIES.find((c) => withinTolerance(m.intervalSec, c));
      return skip(bucket ? `retired ${bucket}s series` : "one-off cadence"), false;
    }
    if (!(m.expiry > 0)) return skip("no expiry"), false;
    if (opts.tradedOnly && m.tradeCount <= 0) return skip("never traded"), false;
    return true;
  });
  if (markets.length === 0) {
    return { samples: [], marketsUsed: 0, marketsTotal, skipped, from: 0, to: 0 };
  }

  log("resolving opening references…");
  const refsRaw = await idx.openingReferences(markets.map((m) => m.marketId));
  log(`  ${refsRaw.size}/${markets.length} windows have a resolved reference`);

  const from = Math.min(...markets.map((m) => startOf(m)));
  const to = Math.max(...markets.map((m) => m.expiry));

  const bars = new Map<Asset, BarIndex>();
  for (const asset of ASSETS) {
    if (!markets.some((m) => m.asset === asset)) continue;
    log(`fetching ${asset} M1 candles…`);
    // Pull the volatility lookback before the earliest window too, or the first
    // markets in the range have no history to measure sigma from.
    const series = await idx.candles(asset, from - lookback * 60 - 60, to + 120);
    log(`  ${series.length} bars`);
    bars.set(asset, new BarIndex(series));
  }

  const samples: Sample[] = [];
  let used = 0;
  for (const m of markets) {
    const raw = refsRaw.get(m.marketId.toLowerCase());
    if (raw === undefined) {
      skip("no reference");
      continue;
    }
    const index = bars.get(m.asset);
    if (!index) {
      skip("no bars for asset");
      continue;
    }
    const start = startOf(m);

    // Resolve the oracle's decimal scale against spot at the window's OPEN.
    // The reference IS the opening price, so that anchor is exact by
    // construction — far safer than guessing from a mid-window price that may
    // have drifted, and it is the only defence against the 1e2/1e4 ambiguity.
    const openIdx = index.at(start);
    if (openIdx < 0) {
      skip("no bar at open");
      continue;
    }
    const reference = scaleReference(raw, index.bars[openIdx]!.close);
    if (reference === null) {
      skip("reference scale unresolvable");
      continue;
    }

    const life = m.expiry - start;
    if (life <= 0) {
      skip("non-positive life");
      continue;
    }
    const y: 0 | 1 = m.winningOutcome === 0 ? 1 : 0;
    let produced = 0;

    for (const phase of samplePoints) {
      const t = start + life * phase;
      const i = index.at(t);
      if (i < 0) {
        skip("no bar at sample");
        continue;
      }
      const spot = index.bars[i]!.close;
      const sigmaPerMin = sigmaPerMinute(index.bars, i, lookback);
      if (sigmaPerMin === null) {
        skip("insufficient vol history");
        continue;
      }
      const tauMinutes = (m.expiry - t) / 60;
      if (tauMinutes <= 0) {
        skip("expired at sample");
        continue;
      }
      const fv = fairValue({ spot, reference, sigmaPerMin, tauMinutes });
      if (!fv) {
        skip("fair value undefined");
        continue;
      }
      samples.push({
        p: fv.pUp,
        y,
        marketId: m.marketId,
        asset: m.asset,
        intervalSec: m.intervalSec,
        phase,
        tauMinutes,
        settleAt: m.expiry,
        spot,
        reference,
        sigmaPerMin,
        z: fv.z,
      });
      produced++;
    }
    if (produced > 0) used++;
  }

  return { samples, marketsUsed: used, marketsTotal, skipped, from, to };
}

/** Window open: the row's own `tradingStart`, or expiry minus the cadence. */
const startOf = (m: MarketRow): number =>
  m.tradingStart > 0 ? m.tradingStart : m.expiry - (m.intervalSec || 900);
