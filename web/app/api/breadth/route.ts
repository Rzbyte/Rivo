// The breadth study, live.
//
// Same function `npm run breadth` calls, so this route and the dated artefact in
// docs/evidence cannot disagree about anything but when they were computed. The
// live one is what /agents renders, because the sample grows every time a
// contract settles and a page that needed a redeploy to show that would be
// telling yesterday's answer.
//
// Public and unauthenticated: every number here is hypothetical and already
// published, and there is nothing in it a stranger should not see.

import { NextResponse } from "next/server";
import { configured } from "@rivo/db/pool.js";
import { breadthReport } from "@rivo/intel/breadth-report.js";

export const dynamic = "force-dynamic";

/**
 * One aggregation per window, shared across requests.
 *
 * The report walks every agent's settled decisions, which is a handful of
 * queries per agent — cheap once, wasteful on every poll from every open tab.
 * /agents polls this on a 30s cycle and the underlying number moves on the
 * worker's schedule, not on the reader's.
 */
const TTL_MS = 20_000;
let cached: { at: number; body: unknown } | null = null;

export async function GET(): Promise<Response> {
  if (!configured()) {
    return NextResponse.json(
      { error: "no database configured", strategies: [] },
      { status: 503 },
    );
  }
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json(cached.body);
  }
  try {
    const body = await breadthReport();
    cached = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (e) {
    // An empty list would render as "no strategies are running", which is a
    // different and much worse claim than "we could not read the ledger".
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "the shadow ledger did not answer", strategies: [] },
      { status: 503 },
    );
  }
}
