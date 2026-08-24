// The execution chain, for one portfolio.
//
// Public when a deployment publishes one via RIVO_DEMO_PORTFOLIO_ID, and
// otherwise an honest empty state — a judge should be able to inspect the
// evidence without an account, and an operator should have to opt in before
// their portfolio becomes somebody else's reading material.

import { NextResponse } from "next/server";
import { query, configured } from "@rivo/db/pool.js";
import { portfolioById } from "@rivo/db/portfolios.js";
import { buildView } from "@rivo/db/view.js";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!configured()) return NextResponse.json({ error: "no database configured" }, { status: 503 });

  const url = new URL(req.url);
  const id = url.searchParams.get("portfolio") ?? process.env.RIVO_DEMO_PORTFOLIO_ID ?? null;
  if (!id) {
    return NextResponse.json({
      portfolio: null,
      note: "No portfolio is published on this deployment. Set RIVO_DEMO_PORTFOLIO_ID to publish one read-only.",
    });
  }

  const p = await portfolioById(id);
  if (!p) return NextResponse.json({ error: "no such portfolio" }, { status: 404 });
  const view = await buildView(p);

  // Which agent this deployment runs. Null means the built-in reference model,
  // which every portfolio predating the agent registry has in fact been running.
  const [agent] = await query<{ id: string; slug: string; label: string; state: string }>(
    `SELECT a.id, a.slug, a.label, a.state
       FROM portfolios p LEFT JOIN agents a ON a.id = p.agent_id
      WHERE p.id = $1 AND a.id IS NOT NULL`,
    [id],
  );

  // The counts that must never be conflated, each scoped to THIS run.
  //
  // The shadow subqueries used to have no scope at all: they counted every
  // decision from every agent and reported the total inside a portfolio-specific
  // object, so a reader looking at one deployment saw another agent's numbers
  // attributed to it. Evidence integrity outranks an impressive number.
  const [counts] = await query<{
    attempts: string; submitted: string; confirmed: string; failed: string;
    open_lots: string; closed_lots: string; shadow: string; shadow_settled: string;
    agent_unscoped: string; agent_unscoped_settled: string; agent_total: string;
  }>(
    `SELECT
       (SELECT count(*) FROM executions WHERE portfolio_id = $1)::text                                AS attempts,
       (SELECT count(*) FROM executions WHERE portfolio_id = $1 AND tx_hash IS NOT NULL)::text        AS submitted,
       (SELECT count(*) FROM executions WHERE portfolio_id = $1 AND status = 'confirmed'
          AND tx_hash IS NOT NULL)::text                                                              AS confirmed,
       (SELECT count(*) FROM executions WHERE portfolio_id = $1 AND status = 'failed')::text          AS failed,
       (SELECT count(*) FROM positions  WHERE portfolio_id = $1 AND status = 'open')::text            AS open_lots,
       (SELECT count(*) FROM positions  WHERE portfolio_id = $1 AND status = 'closed')::text          AS closed_lots,
       -- THIS RUN. Nothing else.
       --
       -- This read: portfolio_id IS NULL OR portfolio_id = $1 — which merged
       -- every decision the agent made outside any deployment into this
       -- deployment's totals. Those unscoped rows are real evidence about the
       -- AGENT — an agent connected but not deployed still gets asked every
       -- pass — and they say nothing about what this run did. Adding them
       -- inflated a run's decision count by everything the agent had ever
       -- thought, which is a bigger number and a wrong one.
       (SELECT count(*) FROM shadow_decisions WHERE portfolio_id = $1)::text                          AS shadow,
       (SELECT count(*) FROM shadow_decisions
          WHERE portfolio_id = $1 AND settled_at IS NOT NULL)::text                                   AS shadow_settled,
       -- The unscoped rows, kept apart and labelled. Shown as GLOBAL AGENT
       -- EVIDENCE, never summed into the run.
       (SELECT count(*) FROM shadow_decisions
          WHERE agent_id = $2::uuid AND portfolio_id IS NULL)::text                                   AS agent_unscoped,
       (SELECT count(*) FROM shadow_decisions
          WHERE agent_id = $2::uuid AND portfolio_id IS NULL AND settled_at IS NOT NULL)::text        AS agent_unscoped_settled,
       -- Everything this agent has done, in every run plus outside them. Also
       -- agent-level, also never merged into the run.
       (SELECT count(*) FROM shadow_decisions WHERE agent_id = $2::uuid)::text                        AS agent_total`,
    [id, agent?.id ?? null],
  );

  const txs = await query<{ tx_hash: string; status: string; action: string; created_at: Date }>(
    `SELECT tx_hash, status, action, created_at
       FROM executions
      WHERE portfolio_id = $1 AND tx_hash IS NOT NULL
      ORDER BY created_at DESC LIMIT 25`,
    [id],
  );

  // Ecosystem-wide totals, kept in their own object and labelled, because they
  // describe every agent on the deployment rather than this one.
  const [global] = await query<{ agents: string; shadow: string; settled: string }>(
    `SELECT (SELECT count(*) FROM agents)::text                                     AS agents,
            (SELECT count(*) FROM shadow_decisions)::text                           AS shadow,
            (SELECT count(*) FROM shadow_decisions WHERE settled_at IS NOT NULL)::text AS settled`,
  );

  // One run, walked end to end.
  //
  // The stage counts above say what a deployment has done in total; this says
  // what happened to ONE order, which is the thing a reader can actually follow.
  // Picking the most recent confirmed transaction rather than the most recent
  // attempt: a run that ends at "submitted" is a story without a last page.
  const [latest] = await query<{
    tx_hash: string; status: string; action: string; leg: string;
    market_id: string; created_at: Date;
    filled_qty: string | null; filled_price: string | null; block_number: string | null;
    asset: string | null; interval_sec: number | null;
  }>(
    // `executions` records the order, not the market's shape: asset and tenor
    // live on the position it opened. Joining rather than assuming — the first
    // version of this selected e.asset and e.interval_sec, which do not exist,
    // and the endpoint answered 500 on a portfolio whose data was perfect.
    `SELECT e.tx_hash, e.status, e.action, e.leg, e.market_id, e.created_at,
            e.filled_qty::text, e.filled_price::text, e.block_number::text,
            p.asset, p.interval_sec
       FROM executions e
       LEFT JOIN LATERAL (
         SELECT asset, interval_sec FROM positions
          WHERE portfolio_id = e.portfolio_id AND market_id = e.market_id
          LIMIT 1
       ) p ON true
      WHERE e.portfolio_id = $1 AND e.tx_hash IS NOT NULL AND e.status = 'confirmed'
      ORDER BY e.created_at DESC LIMIT 1`,
    [id],
  );

  // Whether the position that order opened has since resolved.
  const [outcome] = latest
    ? await query<{ status: string; exit: string | null; closed_at: Date | null }>(
        `SELECT status, exit, closed_at FROM positions
          WHERE portfolio_id = $1 AND market_id = $2 AND leg = $3
          ORDER BY opened_at DESC LIMIT 1`,
        [id, latest.market_id, latest.leg],
      )
    : [];

  return NextResponse.json({
    run: latest
      ? {
          asset: latest.asset ?? "—", leg: latest.leg, intervalSec: latest.interval_sec ?? 0,
          action: latest.action,
          submittedAt: latest.created_at,
          txHash: latest.tx_hash,
          blockNumber: latest.block_number,
          filled: latest.filled_qty === null ? null : Number(latest.filled_qty),
          avgPrice: latest.filled_price === null ? null : Number(latest.filled_price),
          settlement: outcome
            ? { status: outcome.status, exit: outcome.exit, closedAt: outcome.closed_at }
            : null,
        }
      : null,
    global: {
      agents: Number(global?.agents ?? 0),
      shadowDecisions: Number(global?.shadow ?? 0),
      shadowSettled: Number(global?.settled ?? 0),
    },
    portfolio: {
      id: p.id,
      address: p.address,
      network: p.network,
      mode: p.policy.mode,
      state: p.policy.state,
    },
    strategy: view.strategy,
    worker: view.worker,
    runtime: view.runtime,
    /**
     * Evidence about the AGENT that does not belong to this run.
     *
     * Its own object, deliberately, so no caller can add it to `counts` without
     * writing the addition down. An agent is asked about every live market on
     * every pass whether or not it is deployed, so this number is large and
     * says nothing about what this deployment did.
     */
    agent: agent
      ? {
          id: agent.id,
          slug: agent.slug,
          label: agent.label,
          state: agent.state,
          /** Decisions this agent made outside any deployment. */
          unscopedDecisions: Number(counts!.agent_unscoped),
          unscopedSettled: Number(counts!.agent_unscoped_settled),
          /** Everything, every run plus unscoped. Never equal to the run's count. */
          totalDecisions: Number(counts!.agent_total),
        }
      : null,
    counts: {
      decisions: view.counts.decisions,
      // HYPOTHETICAL: never left the process, and scoped to THIS run only.
      shadow: Number(counts!.shadow),
      shadowSettled: Number(counts!.shadow_settled),
      // Recorded before signing — an attempt is not a transaction.
      attempts: Number(counts!.attempts),
      submitted: Number(counts!.submitted),
      confirmed: Number(counts!.confirmed),
      failed: Number(counts!.failed),
      openLots: Number(counts!.open_lots),
      closedLots: Number(counts!.closed_lots),
    },
    transactions: txs.map((t) => ({
      hash: t.tx_hash,
      status: t.status,
      action: t.action,
      at: t.created_at,
    })),
  });
}
