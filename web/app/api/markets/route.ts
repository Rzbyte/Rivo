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
import type { CalibrationReport } from "@rivo/intel/calibration.js";
import { query, configured } from "@rivo/db/pool.js";
import { network } from "@rivo/core/config.js";

export const dynamic = "force-dynamic";

const TTL_MS = 8_000;
let cached: { at: number; view: MarketsView } | null = null;

/** The stored calibration, or null when none has been computed. */
async function calibration(): Promise<CalibrationReport | null> {
  if (!configured()) return null;
  const rows = await query<{ report: CalibrationReport }>(
    `SELECT report FROM calibration_reports
      WHERE network = $1 AND asset IS NULL AND interval_sec IS NULL AND basis = 'window'
      ORDER BY computed_at DESC LIMIT 1`,
    [network()],
  );
  return rows[0]?.report ?? null;
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
