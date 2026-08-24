// Evidence belongs to exactly one run, and nothing borrows from anything else.
//
// The bug these exist to prevent shipped, twice, in slightly different forms:
//
//   1. The proof endpoint counted every shadow decision from every agent and
//      presented the total inside a portfolio-specific object.
//   2. Fixed to scope by agent, it then read
//      `portfolio_id IS NULL OR portfolio_id = $1` — which quietly merged every
//      decision the agent had made OUTSIDE any deployment into that
//      deployment's totals. An agent is asked about every live market on every
//      pass whether or not it is deployed, so the unscoped pile is by far the
//      biggest number available, and adding it made a run look busy.
//
// Both were bigger numbers and wrong ones. Nothing in a type checker or a green
// suite catches either, because both are perfectly valid SQL producing a real
// integer — which is exactly why the rule needs tests that construct two agents
// and two runs and demand they stay apart.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { haveDatabase, seedPortfolio, truncateAll, withSchema } from "../db/testing.js";
import { query } from "../db/pool.js";
import { recordShadow, shadowSummary, intentBreakdown } from "./shadow.js";

const d = haveDatabase() ? describe : describe.skip;

/** One agent row, returning its id. */
async function agent(slug: string, state = "SHADOW_ONLY"): Promise<string> {
  const [a] = await query<{ id: string }>(
    `INSERT INTO agents (slug, label, kind, state) VALUES ($1, $2, 'builtin', $3) RETURNING id`,
    [slug, slug, state],
  );
  return a!.id;
}

/** A shadow decision that entered, so it contributes to every count. */
const entered = (agentId: string, portfolioId: string | null, marketId: string) =>
  recordShadow({
    agentId,
    portfolioId,
    marketId,
    asset: "BTC",
    leg: "UP",
    intervalSec: 900,
    expiry: 2_000_000_000,
    marketPrice: 0.5,
    agentPrice: 0.62,
    confidence: 0.8,
    action: "ENTER",
    reason: "test",
    hypotheticalSize: 5,
    hypotheticalEntry: 0.5,
    intent: { outcome: "EXECUTE", stage: "INTENT", code: null, normalizedSize: 10 },
  });

d("evidence scope", () => {
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    teardown = await withSchema("intel_scope");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it("does not let one agent see another agent's decisions", async () => {
    const a = await agent("agent-a");
    const b = await agent("agent-b");
    const runA = (await seedPortfolio({ mode: "shadow" })).portfolioId;
    const runB = (await seedPortfolio({ mode: "shadow" })).portfolioId;
    await query("UPDATE portfolios SET agent_id = $1 WHERE id = $2", [a, runA]);
    await query("UPDATE portfolios SET agent_id = $1 WHERE id = $2", [b, runB]);

    await entered(a, runA, "0xm1");
    await entered(a, runA, "0xm2");
    await entered(b, runB, "0xm3");

    expect((await shadowSummary(a)).decisions).toBe(2);
    expect((await shadowSummary(b)).decisions).toBe(1);
  });

  it("does not let one deployment see another deployment's decisions", async () => {
    // The same agent, deployed twice — a shadow run and an experimental testnet
    // run. This is the normal shape for anything being validated, and it is the
    // case the old "first portfolio by created_at" logic could not represent at
    // all: every decision was stamped with whichever run existed first.
    const a = await agent("two-runs");
    const runA = (await seedPortfolio({ mode: "shadow" })).portfolioId;
    const runB = (await seedPortfolio({ mode: "experimental_testnet" })).portfolioId;
    await query("UPDATE portfolios SET agent_id = $1 WHERE id = ANY($2::uuid[])", [a, [runA, runB]]);

    await entered(a, runA, "0xm1");
    await entered(a, runA, "0xm2");
    await entered(a, runA, "0xm3");
    await entered(a, runB, "0xm4");

    expect((await shadowSummary(a, runA)).decisions).toBe(3);
    expect((await shadowSummary(a, runB)).decisions).toBe(1);
    // And the agent-level view is the sum, which is a DIFFERENT question and is
    // only ever answered when nobody asked about a run.
    expect((await shadowSummary(a)).decisions).toBe(4);
  });

  it("never lets unscoped agent evidence inflate a deployment", async () => {
    // The exact regression. `portfolio_id IS NULL OR portfolio_id = $1` made
    // this test's run report 5 instead of 1.
    const a = await agent("mostly-undeployed");
    const run = (await seedPortfolio({ mode: "shadow" })).portfolioId;
    await query("UPDATE portfolios SET agent_id = $1 WHERE id = $2", [a, run]);

    await entered(a, run, "0xm1");
    for (const m of ["0xu1", "0xu2", "0xu3", "0xu4"]) await entered(a, null, m);

    expect((await shadowSummary(a, run)).decisions).toBe(1);
    // The unscoped rows are real evidence — about the agent, not the run.
    expect((await shadowSummary(a, null)).decisions).toBe(4);
    expect((await shadowSummary(a)).decisions).toBe(5);
  });

  it("keeps shadow and testnet evidence distinguishable", async () => {
    // Two runs of one agent under different modes. A reader must be able to say
    // which evidence came from a run that could sign and which came from one
    // that structurally could not.
    const a = await agent("both-modes");
    const shadowRun = (await seedPortfolio({ mode: "shadow" })).portfolioId;
    const testnetRun = (await seedPortfolio({ mode: "experimental_testnet" })).portfolioId;
    await query("UPDATE portfolios SET agent_id = $1 WHERE id = ANY($2::uuid[])", [a, [shadowRun, testnetRun]]);
    await entered(a, shadowRun, "0xs1");
    await entered(a, testnetRun, "0xt1");

    const modes = await query<{ id: string; mode: string; n: string }>(
      `SELECT p.id, p.mode, count(s.id)::text AS n
         FROM portfolios p JOIN shadow_decisions s ON s.portfolio_id = p.id
        WHERE p.agent_id = $1 GROUP BY p.id, p.mode ORDER BY p.mode`,
      [a],
    );
    expect(modes.map((m) => [m.mode, Number(m.n)])).toEqual([
      ["experimental_testnet", 1],
      ["shadow", 1],
    ]);
  });

  it("breaks a run's decisions down by what stopped them", async () => {
    const a = await agent("breakdown");
    const run = (await seedPortfolio({ mode: "shadow" })).portfolioId;
    await query("UPDATE portfolios SET agent_id = $1 WHERE id = $2", [a, run]);

    await entered(a, run, "0xm1");
    await recordShadow({
      agentId: a, portfolioId: run, marketId: "0xm2", asset: "BTC", leg: "UP",
      intervalSec: 900, expiry: 2_000_000_000, marketPrice: 0.5, agentPrice: null,
      confidence: null, action: "SKIP", reason: "no view",
      hypotheticalSize: null, hypotheticalEntry: null,
      intent: { outcome: "REFUSED", stage: "VENUE", code: "NORMALIZED_SIZE_ZERO", normalizedSize: 0 },
    });

    const rows = await intentBreakdown(a, run);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "EXECUTE", n: 1 }),
        expect.objectContaining({ outcome: "REFUSED", code: "NORMALIZED_SIZE_ZERO", n: 1 }),
      ]),
    );
    // And a breakdown for a DIFFERENT run sees none of it.
    const other = (await seedPortfolio({ mode: "shadow" })).portfolioId;
    expect(await intentBreakdown(a, other)).toEqual([]);
  });
});
