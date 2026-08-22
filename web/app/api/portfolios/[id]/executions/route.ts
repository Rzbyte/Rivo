// The permanent transaction record.
//
// Every action that touched the chain, whether or not the position it belonged
// to still exists. That is the point of it: a closed position used to take its
// transaction hash with it, and this is the table that does not.

import { NextResponse } from "next/server";
import { notFound, withUser } from "@/lib/auth";
import { portfolioOf } from "@rivo/db/portfolios.js";
import { executions } from "@rivo/db/view.js";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withUser(async (user, req, ctx: Ctx) => {
  const { id } = await ctx.params;
  if (!(await portfolioOf(user.id, id))) notFound();
  const url = new URL(req.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  return NextResponse.json({ executions: await executions(id, limit) });
});
