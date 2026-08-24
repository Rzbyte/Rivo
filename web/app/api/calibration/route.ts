// The calibration report, public and unauthenticated.
//
// Nobody should need a wallet to find out whether this venue's probabilities
// mean what they say. That is the product's opening claim and gating it behind
// a sign-in would contradict it on the first click.
//
// Reads the stored report rather than computing one: the computation walks a
// month of fills across every settled window, which is a background job's work
// (`npm run calibration -- --store`) and not a page load's.

import { NextResponse } from "next/server";
import { query, configured } from "@rivo/db/pool.js";
import { network } from "@rivo/core/config.js";

export const dynamic = "force-dynamic";

interface Row {
  basis: string;
  observations: number;
  windows: number;
  period_from: Date;
  period_to: Date;
  brier: string;
  skill: string;
  report: unknown;
  computed_at: Date;
}

export async function GET(): Promise<Response> {
  if (!configured()) {
    return NextResponse.json({ error: "no database configured on this deployment" }, { status: 503 });
  }
  const rows = await query<Row>(
    `SELECT basis, observations, windows, period_from, period_to, brier, skill, report, computed_at
       FROM calibration_reports
      WHERE network = $1 AND asset IS NULL AND interval_sec IS NULL AND basis = 'window'
      ORDER BY computed_at DESC
      LIMIT 1`,
    [network()],
  );
  const r = rows[0];
  if (!r) {
    // An empty state, not an error. A fresh deployment has measured nothing yet,
    // and saying so is more useful than a 500.
    return NextResponse.json({ report: null, note: "no calibration has been computed on this deployment yet" });
  }
  return NextResponse.json({
    report: r.report,
    computedAt: r.computed_at,
    observations: r.observations,
    windows: r.windows,
    brier: Number(r.brier),
    skill: Number(r.skill),
    network: network(),
  });
}
