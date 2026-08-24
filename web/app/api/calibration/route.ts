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
import { artefact } from "@/lib/evidence";

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

/**
 * The last stored report, as a file, for when the database cannot answer.
 *
 * This page carries the project's strongest finding, and it was the only
 * headline with a single point of failure: no database, 503, and the number a
 * reader came for is simply gone. A managed Postgres that sleeps on an idle
 * plan is not a hypothetical.
 *
 * Returned with `stale: true` and the date it was computed, never silently. A
 * fallback that cannot be told apart from live data is worse than the outage —
 * it turns "the database is down" into "these numbers are current", which is
 * the one claim this project must never make by accident.
 */
function snapshot(): Response | null {
  const file = artefact<{ generatedAt?: string; window?: Record<string, unknown> }>("calibration-report");
  const report = file?.window;
  if (!report) return null;
  return NextResponse.json({
    report,
    stale: true,
    computedAt: file?.generatedAt ?? null,
    note: "Served from the stored artefact — this deployment's database did not answer. Figures are from the run named below, not from live settlements.",
    observations: report.n,
    windows: report.windows,
    brier: report.brier,
    skill: report.skill,
    network: network(),
  });
}

export async function GET(): Promise<Response> {
  if (!configured()) {
    return (
      snapshot() ??
      NextResponse.json({ error: "no database configured on this deployment" }, { status: 503 })
    );
  }
  let rows: Row[];
  try {
    rows = await query<Row>(
      `SELECT basis, observations, windows, period_from, period_to, brier, skill, report, computed_at
         FROM calibration_reports
        WHERE network = $1 AND asset IS NULL AND interval_sec IS NULL AND basis = 'window'
        ORDER BY computed_at DESC
        LIMIT 1`,
      [network()],
    );
  } catch {
    // Reachable in the way that matters: a sleeping instance, an exhausted
    // connection pool, a network blip. The finding is a month old either way,
    // so serving it beats serving a stack trace.
    const stale = snapshot();
    if (stale) return stale;
    throw new Error("the calibration store did not answer and no artefact is bundled");
  }
  const r = rows[0];
  if (!r) {
    // An empty state, not an error. A fresh deployment has measured nothing yet,
    // and saying so is more useful than a 500 — but if an artefact is bundled,
    // showing the measurement beats showing the emptiness.
    return (
      snapshot() ??
      NextResponse.json({ report: null, note: "no calibration has been computed on this deployment yet" })
    );
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
