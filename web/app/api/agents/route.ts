// The agent registry, public.
//
// An agent's state is the same word the execution gate reads. A product that
// displayed one verdict and enforced another would be worse than one that
// displayed nothing, so both come from the same place.

import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { query, configured } from "@rivo/db/pool.js";

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
