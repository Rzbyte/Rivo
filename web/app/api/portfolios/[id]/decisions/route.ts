// The forward-test record: every leg considered, and the constraint that bound.

import { NextResponse } from "next/server";
import { notFound, withUser } from "@/lib/auth";
import { portfolioOf } from "@rivo/db/portfolios.js";
import { decisionGroups } from "@rivo/db/view.js";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withUser(async (user, req, ctx: Ctx) => {
  const { id } = await ctx.params;
  if (!(await portfolioOf(user.id, id))) notFound();
  const url = new URL(req.url);
  const cycles = Math.min(50, Math.max(1, Number(url.searchParams.get("cycles") ?? 8) || 8));
  return NextResponse.json({ decisions: await decisionGroups(id, cycles) });
});
