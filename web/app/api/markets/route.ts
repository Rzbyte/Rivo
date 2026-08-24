// Live Event Contract intelligence, public and unauthenticated.
//
// Cached for a few seconds because a snapshot costs several round trips to the
// indexer — the market list, the resting orders on every window, the spot for
// each asset and a window of candles. Serving that per request would make the
// page slow and the venue's indexer unhappy, and Event Contract prices do not
// move meaningfully inside the cache window.

import { NextResponse } from "next/server";
import { Indexer } from "@rivo/core/indexer.js";
import { snapshot } from "@rivo/engine/scan.js";
import { marketsView, type MarketsView } from "@rivo/intel/markets.js";
import { cohortKey, type CalibrationReport } from "@rivo/intel/calibration.js";
import { query, configured } from "@rivo/db/pool.js";
import { network } from "@rivo/core/config.js";

export const dynamic = "force-dynamic";

const TTL_MS = 8_000;
let cached: { at: number; view: MarketsView } | null = null;

/**
 * The newest report for every cohort, keyed by cohort.
 *
 * `DISTINCT ON` takes the latest row per cohort in one pass — a market card
 * needs its own cohort and every wider one it might fall back to, and fetching
 * them separately would be four round trips per card.
 */
async function calibration(): Promise<Map<string, CalibrationReport>> {
  const out = new Map<string, CalibrationReport>();
  if (!configured()) return out;
  const rows = await query<{ asset: string | null; interval_sec: number | null; report: CalibrationReport }>(
    `SELECT DISTINCT ON (asset, interval_sec) asset, interval_sec, report
       FROM calibration_reports
      WHERE network = $1 AND basis = 'window'
      ORDER BY asset, interval_sec, computed_at DESC`,
    [network()],
  );
  for (const r of rows) out.set(cohortKey({ asset: r.asset, intervalSec: r.interval_sec }), r.report);
  return out;
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) {
    return NextResponse.json({ ...cached.view, cached: true });
  }
  try {
    const [snap, cal] = await Promise.all([snapshot(new Indexer()), calibration()]);
    const view = marketsView(snap, cal);
    cached = { at: now, view };
    return NextResponse.json({ ...view, cached: false });
  } catch (e) {
    // Say the venue is unreachable rather than rendering an empty market list,
    // which reads as "no markets exist".
    return NextResponse.json(
      { error: `could not reach the venue: ${e instanceof Error ? e.message : String(e)}` },
      { status: 503 },
    );
  }
}
