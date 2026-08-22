// One portfolio, readable by anybody, if the operator says so.
//
// The product is behind a sign-in, which is correct and which makes it invisible
// to anyone who does not have credentials for this deployment — a reviewer, a
// judge, somebody deciding whether to try it. This is the narrowest possible
// answer to that: ONE portfolio, named explicitly by the operator in
// RIVO_DEMO_PORTFOLIO_ID, exposed read-only.
//
// Every part of that sentence is load-bearing:
//
//   * Not set, no endpoint. It 404s, so a deployment that never opted in has no
//     unauthenticated surface at all.
//   * One id, from the environment. There is no parameter, so this cannot be
//     turned into "read any portfolio" by a caller.
//   * GET only, and it reaches nothing but the same read-only view builder the
//     authenticated route uses.
//
// What it does expose is a portfolio's decisions, positions and transactions —
// which is the point, and which is why the id must be one the operator chose.

import { NextResponse } from "next/server";
import { configured } from "@rivo/db/pool.js";
import { portfolioById } from "@rivo/db/portfolios.js";
import { buildView, closedPositions, decisionGroups, events, executions } from "@rivo/db/view.js";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const id = process.env.RIVO_DEMO_PORTFOLIO_ID?.trim();
  if (!id || !configured()) {
    return NextResponse.json({ error: "no demo portfolio is published on this deployment" }, { status: 404 });
  }
  // A malformed id would reach the database as a cast error rather than a
  // lookup. Check the shape here so a typo in an environment variable produces
  // a 404 and not a 500.
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    console.error("RIVO_DEMO_PORTFOLIO_ID is not a uuid");
    return NextResponse.json({ error: "no demo portfolio is published on this deployment" }, { status: 404 });
  }
  const portfolio = await portfolioById(id);
  if (!portfolio) {
    return NextResponse.json({ error: "no demo portfolio is published on this deployment" }, { status: 404 });
  }
  const [view, decisions, ledger, closed, recentEvents] = await Promise.all([
    buildView(portfolio),
    decisionGroups(id, 8),
    executions(id, 50),
    closedPositions(id, 25),
    events(id, 20),
  ]);
  return NextResponse.json({ view, decisions, executions: ledger, closed, events: recentEvents });
}
