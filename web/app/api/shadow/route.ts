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
  /** Which run recorded this. Null means the agent was asked outside any deployment. */
  portfolio_id: string | null; run_mode: string | null;
  /** What the shared pre-execution pipeline said, before the fork away from a signer. */
  intent_outcome: string | null; intent_stage: string | null; intent_code: string | null;
  normalized_size: string | null;
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
            s.settled_at, s.outcome, s.hypothetical_pnl::text,
            s.portfolio_id, p.mode AS run_mode,
            s.intent_outcome, s.intent_stage, s.intent_code, s.normalized_size::text
       FROM shadow_decisions s
       JOIN agents a ON a.id = s.agent_id
       LEFT JOIN portfolios p ON p.id = s.portfolio_id
      ORDER BY s.decided_at DESC LIMIT $1`,
    [limit],
  );

  // What the pipeline did with them, grouped. This is the number that tells a
  // reader shadow is running the same checks as the real path rather than
  // writing down whatever an agent said: if every decision were EXECUTE, the
  // constraints would not be binding on anything.
  const intents = await query<{ outcome: string; code: string | null; n: string }>(
    `SELECT coalesce(intent_outcome, 'UNRECORDED') AS outcome, intent_code AS code, count(*)::text AS n
       FROM shadow_decisions
      GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 12`,
  );

  // The heartbeat. Shadow claims to be autonomous, so a reader has to be able
  // to see that something is actually alive without taking the word for it.
  const [beat] = await query<{ last: Date | null; workers: string; heartbeat: Date | null }>(
    `SELECT (SELECT max(decided_at) FROM shadow_decisions)                              AS last,
            (SELECT count(*) FROM workers
              WHERE last_heartbeat_at > now() - interval '90 seconds')::text            AS workers,
            (SELECT max(last_heartbeat_at) FROM workers)                                AS heartbeat`,
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
      /** The run, so a reader can tell which deployment produced this. */
      runId: r.portfolio_id,
      runMode: r.run_mode,
      /** What the shared pipeline decided. Never a transaction, in any case. */
      intent: r.intent_outcome
        ? {
            outcome: r.intent_outcome,
            stage: r.intent_stage,
            code: r.intent_code,
            normalizedSize: n(r.normalized_size),
          }
        : null,
    })),
    summary: {
      total: Number(sum?.total ?? 0),
      entered: Number(sum?.entered ?? 0),
      settled: Number(sum?.settled ?? 0),
      hypotheticalPnl: n(sum?.pnl ?? null),
      hitRate: n(sum?.hits ?? null),
    },
    /** How the shared pre-execution pipeline disposed of every shadow decision. */
    intents: intents.map((i) => ({ outcome: i.outcome, code: i.code, n: Number(i.n) })),
    heartbeat: {
      lastDecisionAt: beat?.last ?? null,
      lastWorkerBeatAt: beat?.heartbeat ?? null,
      liveWorkers: Number(beat?.workers ?? 0),
    },
  });
}
