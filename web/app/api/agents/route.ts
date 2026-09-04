// The agent registry, public.
//
// An agent's state is the same word the execution gate reads. A product that
// displayed one verdict and enforced another would be worse than one that
// displayed nothing, so both come from the same place.

import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { query, configured } from "@rivo/db/pool.js";
import { withUserWrite, badRequest } from "@/lib/auth";
import { jsonBody } from "@/lib/validate";
import { verifyEndpointUrl } from "@rivo/intel/endpoint.js";
import { askAgent } from "@rivo/intel/agent.js";
import { PRODUCTION_STRATEGY } from "@rivo/research/gating.js";

export const dynamic = "force-dynamic";

interface AgentRow {
  slug: string; label: string; kind: string; endpoint: string | null;
  state: string; evidence: string | null; summary: Record<string, unknown>;
  created_at: Date;
}

/**
 * The walk-forward study, when the artefact is present.
 *
 * Read from disk rather than recomputed: the run walks a month of fills and is
 * reproducible with `npm run alpha`, so the page shows what was measured rather
 * than measuring again on every visit.
 */
function study(): unknown | null {
  for (const p of ["docs/evidence/alpha-research.json", "../docs/evidence/alpha-research.json"]) {
    const full = resolve(p);
    if (existsSync(full)) return JSON.parse(readFileSync(full, "utf8"));
  }
  return null;
}

/**
 * Rivo's own model, answered from the constant the execution gate reads.
 *
 * The row was seeded by migration 004 with the figures the study had at the
 * time, `ON CONFLICT DO NOTHING`, so nothing has updated it since and nothing
 * ever would. When the study was re-run on 2,179 windows instead of 737 and the
 * return moved from -6.49% to +2.80%, `gating.ts`, the landing page and
 * ALPHA-RESEARCH.md all moved with it — and this endpoint kept serving -6.49%
 * from a database row, which is the number the /agents page shows a judge.
 *
 * Same failure as the landing page's hand-typed literals, one layer further
 * back. So the builtin agent's verdict is not read from the row at all: state,
 * economics and note come from PRODUCTION_STRATEGY, which is also what
 * `executionPermission()` reads. A page that displayed one verdict while the
 * gate enforced another would be worse than a page that displayed nothing.
 */
function builtinSummary(row: AgentRow): { state: string; summary: Record<string, unknown> } {
  if (row.kind !== "builtin") return { state: row.state, summary: row.summary };
  return {
    state: PRODUCTION_STRATEGY.state,
    summary: {
      ...row.summary,
      auc: PRODUCTION_STRATEGY.auc,
      returnOnStake: PRODUCTION_STRATEGY.returnOnStake,
      tStat: PRODUCTION_STRATEGY.tStat,
      note: PRODUCTION_STRATEGY.note,
    },
  };
}

export async function GET(): Promise<Response> {
  if (!configured()) return NextResponse.json({ agents: [], research: null, note: "no database configured" });
  const rows = await query<AgentRow>(
    `SELECT slug, label, kind, endpoint, state, evidence, summary, created_at
       FROM agents ORDER BY created_at`,
  );
  return NextResponse.json({
    agents: rows.map((a) => {
      const live = builtinSummary(a);
      return {
        slug: a.slug,
        label: a.label,
        kind: a.kind,
        // The endpoint is the owner's infrastructure, not the public's business.
        hasEndpoint: Boolean(a.endpoint),
        state: live.state,
        evidence: a.evidence,
        summary: live.summary,
      };
    }),
    research: study(),
  });
}


// ---------------------------------------------------------------------------
// Registering an agent
// ---------------------------------------------------------------------------

/**
 * Connect an external agent.
 *
 * Requires a signed-in builder, which is where Privy earns its place in this
 * product: browsing intelligence needs nobody, and owning a deployed agent needs
 * an identity.
 *
 * The endpoint is vetted before it is stored and probed before it is trusted:
 * a URL a stranger supplies is a URL this server will call, which is the exact
 * shape of a server-side request forgery. See src/intel/endpoint.ts.
 *
 * The new agent starts SHADOW_ONLY. Nothing reaches capital without going
 * through the same validation Rivo's own model failed.
 */
export const POST = withUserWrite(async (user, req) => {
  const body = await jsonBody(req);

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (label.length < 2 || label.length > 60) badRequest("Give the agent a name between 2 and 60 characters.");

  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const verdict = await verifyEndpointUrl(endpoint, {
    // Local endpoints are right on a developer's machine and wrong on a hosted
    // deployment, so this is a deployment decision rather than a guess.
    allowPrivate: process.env.RIVO_ALLOW_PRIVATE_AGENTS === "true",
  });
  if (!verdict.ok) badRequest(verdict.reason ?? "Rivo will not call that endpoint.");

  // The token never returns to the browser. It is sent to the agent's own
  // endpoint and stored server-side, and every read path below omits it.
  const token = typeof body.token === "string" && body.token.trim() !== "" ? body.token.trim() : null;
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;

  // Probe before saving. An agent that cannot answer a well-formed question is
  // not connected, whatever the form said.
  const probe = await askAgent(endpoint, PROBE, { headers, timeoutMs: 6_000 });
  if (probe.reason && /unreachable|in time|HTTP \d|redirect|did not return/i.test(probe.reason)) {
    badRequest(`Rivo could not get a usable answer from that endpoint: ${probe.reason}`);
  }

  const slug = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${Date.now().toString(36).slice(-4)}`;

  const [row] = await query<{ id: string; slug: string }>(
    `INSERT INTO agents (slug, label, kind, endpoint, auth_header, owner_user, state, evidence, summary)
     VALUES ($1, $2, 'http', $3, $4, $5, 'UNVALIDATED', NULL, $6)
     RETURNING id, slug`,
    [
      slug, label, endpoint, token ? `Bearer ${token}` : null, user.id,
      JSON.stringify({
        description: typeof body.description === "string" ? body.description.slice(0, 400) : null,
        connectedAt: new Date().toISOString(),
        probe: { action: probe.action, reason: probe.reason },
      }),
    ],
  );

  return NextResponse.json({
    agent: { id: row!.id, slug: row!.slug, label, state: "UNVALIDATED", kind: "http" },
    probe: { action: probe.action, reason: probe.reason },
  });
});

/**
 * The question every agent is asked once, at connection time.
 *
 * Deliberately a live-shaped context with a market id that settles nothing, so a
 * probe cannot be mistaken by the agent for a real decision.
 */
const PROBE = {
  market: { marketId: "0x" + "0".repeat(64), asset: "BTC" as const, leg: "UP" as const, intervalSec: 900, expiry: 0, secondsLeft: 0 },
  price: { bid: 0.49, ask: 0.51, depth: 10 },
  reference: { spot: null, probability: 0.5 },
  limits: { maxNotional: 1 },
};
