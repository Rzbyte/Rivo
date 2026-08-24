// The shadow ledger, public.
//
// Every number here is hypothetical and the field names say so. A reader must
// never have to work out whether they are looking at a trade or a claim about
// one, which is why this is a separate endpoint from /api/proof rather than a
// section inside it.

import { NextResponse } from "next/server";
import { query, configured } from "@rivo/db/pool.js";

export const dynamic = "force-dynamic";

interface Row {
  slug: string; label: string; state: string;
  asset: string; leg: string; interval_sec: number;
  decided_at: Date; expiry: Date;
  market_price: string; agent_price: string | null; confidence: string | null;
  action: string; reason: string | null;
  hypothetical_size: string | null; hypothetical_entry: string | null;
  settled_at: Date | null; outcome: number | null; hypothetical_pnl: string | null;
}

const n = (v: string | null): number | null => (v === null ? null : Number(v));

export async function GET(req: Request): Promise<Response> {
  if (!configured()) return NextResponse.json({ decisions: [], summary: null, note: "no database configured" });
  const limit = Math.min(200, Number(new URL(req.url).searchParams.get("limit") ?? 50));

  const rows = await query<Row>(
    `SELECT a.slug, a.label, a.state,
            s.asset, s.leg, s.interval_sec, s.decided_at, s.expiry,
            s.market_price::text, s.agent_price::text, s.confidence::text,
            s.action, s.reason,
            s.hypothetical_size::text, s.hypothetical_entry::text,
            s.settled_at, s.outcome, s.hypothetical_pnl::text
       FROM shadow_decisions s JOIN agents a ON a.id = s.agent_id
      ORDER BY s.decided_at DESC LIMIT $1`,
    [limit],
  );

  const [sum] = await query<{ total: string; entered: string; settled: string; pnl: string | null; hits: string | null }>(
    `SELECT count(*)::text                                                          AS total,
            count(*) FILTER (WHERE action = 'ENTER')::text                          AS entered,
            count(settled_at)::text                                                 AS settled,
            sum(hypothetical_pnl)::text                                             AS pnl,
            avg(outcome::numeric) FILTER (WHERE hypothetical_entry IS NOT NULL)::text AS hits
       FROM shadow_decisions`,
  );

  return NextResponse.json({
    decisions: rows.map((r) => ({
      agent: { slug: r.slug, label: r.label, state: r.state },
      asset: r.asset, leg: r.leg, intervalSec: r.interval_sec,
      decidedAt: r.decided_at, expiry: r.expiry,
      marketPrice: Number(r.market_price),
      agentPrice: n(r.agent_price),
      confidence: n(r.confidence),
      action: r.action, reason: r.reason,
      hypotheticalSize: n(r.hypothetical_size),
      hypotheticalEntry: n(r.hypothetical_entry),
      settledAt: r.settled_at, outcome: r.outcome,
      hypotheticalPnl: n(r.hypothetical_pnl),
    })),
    summary: {
      total: Number(sum?.total ?? 0),
      entered: Number(sum?.entered ?? 0),
      settled: Number(sum?.settled ?? 0),
      hypotheticalPnl: n(sum?.pnl ?? null),
      hitRate: n(sum?.hits ?? null),
    },
  });
}
