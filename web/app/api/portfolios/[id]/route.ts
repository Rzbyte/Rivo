// One portfolio: the whole picture, and the settings form.

import { NextResponse } from "next/server";
import { badRequest, notFound, withUser } from "@/lib/auth";
import { amount, isProfile, jsonBody, overrides } from "@/lib/validate";
import { portfolioOf, updatePolicy } from "@rivo/db/portfolios.js";
import type { ProfileName } from "@rivo/portfolio/profiles.js";
import { buildView, closedPositions, decisionGroups, events, executions } from "@rivo/db/view.js";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withUser(async (user, req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const portfolio = await portfolioOf(user.id, id);
  if (!portfolio) notFound();

  // One round trip for the whole dashboard. Six sequential queries against a
  // managed database on another continent is most of a second of latency for
  // no reason — none of these depends on another.
  const [view, decisions, ledger, closed, recentEvents] = await Promise.all([
    buildView(portfolio!),
    decisionGroups(id, 8),
    executions(id, 50),
    closedPositions(id, 25),
    events(id, 20),
  ]);

  return NextResponse.json({ view, decisions, executions: ledger, closed, events: recentEvents });
});

/**
 * Change the configuration.
 *
 * Capital and risk only. Nothing here can start, stop or un-halt a portfolio —
 * those are lifecycle transitions with their own rules, and a settings form that
 * could resume a halted portfolio would silently undo a circuit breaker.
 */
export const PATCH = withUser(async (user, req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await jsonBody(req);

  const patch: Parameters<typeof updatePolicy>[2] = {};
  if (body.capital !== undefined) {
    const capital = amount(body.capital, "capital");
    if (capital <= 0) badRequest("capital must be greater than zero");
    patch.capital = capital;
  }
  if (body.profile !== undefined) {
    const p = body.profile;
    if (!isProfile(p)) badRequest("profile must be conservative, balanced or active");
    patch.profile = p as ProfileName;
  }
  if (body.overrides !== undefined) patch.overrides = overrides(body.overrides);
  if (Object.keys(patch).length === 0) badRequest("nothing to change");

  const updated = await updatePolicy(user.id, id, patch);
  if (!updated) notFound();
  return NextResponse.json({ view: await buildView(updated!) });
});
