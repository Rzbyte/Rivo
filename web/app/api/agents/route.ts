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

export async function GET(): Promise<Response> {
  if (!configured()) return NextResponse.json({ agents: [], research: null, note: "no database configured" });
  const rows = await query<AgentRow>(
    `SELECT slug, label, kind, endpoint, state, evidence, summary, created_at
       FROM agents ORDER BY created_at`,
  );
  return NextResponse.json({
    agents: rows.map((a) => ({
      slug: a.slug,
      label: a.label,
      kind: a.kind,
      // The endpoint is the owner's infrastructure, not the public's business.
      hasEndpoint: Boolean(a.endpoint),
      state: a.state,
      evidence: a.evidence,
      summary: a.summary,
    })),
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
