// Shadow, where the whole risk is a sentence rather than a crash: somebody
// quotes a hypothetical result as a real one.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { haveDatabase, seedPortfolio, truncateAll, withSchema } from "../db/testing.js";
import { query } from "../db/pool.js";
import { payout, hypotheticalPnl, recordShadow, pendingShadow, resolveShadow, shadowSummary } from "./shadow.js";

describe("settlement arithmetic", () => {
  it("pays the UP leg when the venue reports outcome 0", () => {
    expect(payout("UP", 0, false)).toBe(1);
    expect(payout("DOWN", 0, false)).toBe(0);
    expect(payout("UP", 1, false)).toBe(0);
    expect(payout("DOWN", 1, false)).toBe(1);
  });

  it("returns null for a voided market rather than calling it a loss", () => {
    // Writing 0 would say the leg lost. Nothing happened.
    expect(payout("UP", 0, true)).toBeNull();
    expect(payout("DOWN", 1, true)).toBeNull();
    expect(payout("UP", null, false)).toBeNull();
  });

  it("prices a hypothetical entry as settlement minus entry", () => {
    expect(hypotheticalPnl(1, 0.4, 10)).toBeCloseTo(6, 10);
    expect(hypotheticalPnl(0, 0.4, 10)).toBeCloseTo(-4, 10);
  });

  it("records an outcome without a P&L when the agent never sized it", () => {
    // Null is not zero. An agent that declined to size has no result to quote.
    expect(hypotheticalPnl(1, null, 10)).toBeNull();
    expect(hypotheticalPnl(1, 0.4, null)).toBeNull();
  });
});

describe.skipIf(!haveDatabase())("the shadow ledger", () => {
  let teardown: () => Promise<void>;
  let agentId: string;

  beforeAll(async () => {
    teardown = await withSchema("shadow");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll();
    const [a] = await query<{ id: string }>(
      `INSERT INTO agents (slug, label, kind, state) VALUES ('t','T','builtin','SHADOW_ONLY') RETURNING id`,
    );
    agentId = a!.id;
  });

  const decide = (over: Partial<Parameters<typeof recordShadow>[0]> = {}) =>
    recordShadow({
      agentId, marketId: "0xm", asset: "BTC", leg: "UP", intervalSec: 900,
      expiry: Math.floor(Date.now() / 1000) - 600,
      marketPrice: 0.4, agentPrice: 0.55, confidence: 0.6,
      action: "ENTER", reason: "test", hypotheticalSize: 10, hypotheticalEntry: 0.4,
      ...over,
    });

  it("records a decision that moved nothing", async () => {
    await decide();
    const [r] = await query<{ n: string; settled: string }>(
      `SELECT count(*)::text n, count(settled_at)::text settled FROM shadow_decisions`,
    );
    expect(r!.n).toBe("1");
    expect(r!.settled).toBe("0");
  });

  it("does not touch executions, positions or the portfolio ledger", async () => {
    // The separation that stops a hypothetical becoming a reported trade.
    await decide();
    for (const t of ["executions", "positions", "decisions"]) {
      const [c] = await query<{ n: string }>(`SELECT count(*)::text n FROM ${t}`);
      expect(c!.n, `${t} must stay empty`).toBe("0");
    }
  });

  it("finds expired rows and leaves fresh ones alone", async () => {
    const now = Math.floor(Date.now() / 1000);
    await decide({ expiry: now - 600 });
    await decide({ expiry: now + 3600 });
    const pending = await pendingShadow(now);
    expect(pending).toHaveLength(1);
  });

  it("respects the grace period, because expiry is not finalisation", async () => {
    const now = Math.floor(Date.now() / 1000);
    await decide({ expiry: now - 10 });
    expect(await pendingShadow(now, 120)).toHaveLength(0);
    expect(await pendingShadow(now, 5)).toHaveLength(1);
  });

  it("resolves once and refuses to resolve twice", async () => {
    const now = Math.floor(Date.now() / 1000);
    await decide({ expiry: now - 600 });
    const [p] = await pendingShadow(now);
    expect(await resolveShadow(p!.id, 1, hypotheticalPnl(1, p!.hypotheticalEntry, p!.hypotheticalSize))).toBe(true);
    // Idempotent: a second pass over the same row must not overwrite it.
    expect(await resolveShadow(p!.id, 0, -4)).toBe(false);
    const [row] = await query<{ outcome: number; pnl: string }>(
      `SELECT outcome, hypothetical_pnl::text AS pnl FROM shadow_decisions`,
    );
    expect(row!.outcome).toBe(1);
    expect(Number(row!.pnl)).toBeCloseTo(6, 6);
  });

  it("leaves a resolved row out of the pending set", async () => {
    const now = Math.floor(Date.now() / 1000);
    await decide({ expiry: now - 600 });
    const [p] = await pendingShadow(now);
    await resolveShadow(p!.id, 1, 6);
    expect(await pendingShadow(now)).toHaveLength(0);
  });

  it("summarises without ever calling a hypothetical a result", async () => {
    const now = Math.floor(Date.now() / 1000);
    await decide({ expiry: now - 600 });
    await decide({ expiry: now - 600, action: "SKIP", hypotheticalSize: null, hypotheticalEntry: null });
    const pending = await pendingShadow(now);
    for (const p of pending) {
      await resolveShadow(p.id, 1, hypotheticalPnl(1, p.hypotheticalEntry, p.hypotheticalSize));
    }
    const s = await shadowSummary(agentId);
    expect(s.decisions).toBe(2);
    expect(s.settled).toBe(2);
    // Only the sized one counts as an entry; the SKIP has no result.
    expect(s.entered).toBe(1);
    expect(s.hypotheticalPnl).toBeCloseTo(6, 6);
  });

  it("never attributes one agent's decisions to another", async () => {
    // The bug this guards: the proof endpoint counted every shadow decision
    // from every agent and reported the total inside a portfolio-specific
    // object, so a reader looking at one deployment saw another agent's numbers
    // attributed to it. An impressive statistic that is wrong is worse than a
    // small one that is right.
    const [other] = await query<{ id: string }>(
      `INSERT INTO agents (slug, label, kind, state) VALUES ('o','O','builtin','SHADOW_ONLY') RETURNING id`,
    );
    await decide();
    await decide({ agentId: other!.id });
    await decide({ agentId: other!.id });

    expect((await shadowSummary(agentId)).decisions).toBe(1);
    expect((await shadowSummary(other!.id)).decisions).toBe(2);
  });

  it("separates two deployments of the same agent", async () => {
    // An agent can run in a shadow deployment and a testnet deployment at once.
    // Reporting both under either is the same class of error one level down.
    const mk = async (): Promise<string> => {
      const { userId, walletId } = await seedPortfolio();
      const [row] = await query<{ id: string }>(
        `INSERT INTO portfolios (user_id, wallet_id, network, capital, profile, mode, state, agent_id)
         VALUES ($1, $2, 'testnet', 50, 'balanced', 'shadow', 'running', $3) RETURNING id`,
        [userId, walletId, agentId],
      );
      return row!.id;
    };
    const a = await mk();
    const b = await mk();
    await decide({ portfolioId: a });
    await decide({ portfolioId: a });
    await decide({ portfolioId: b });

    expect((await shadowSummary(agentId, a)).decisions).toBe(2);
    expect((await shadowSummary(agentId, b)).decisions).toBe(1);
    // Unscoped still sees everything the agent did, which is the other true answer.
    expect((await shadowSummary(agentId)).decisions).toBe(3);
  });

  it("keeps outcome and settled_at together or not at all", async () => {
    // The constraint that stops a row claiming an outcome it never received.
    await decide();
    await expect(
      query(`UPDATE shadow_decisions SET outcome = 1`),
    ).rejects.toThrow();
  });
});
