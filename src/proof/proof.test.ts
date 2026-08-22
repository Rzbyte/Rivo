// The evidence tooling, checked against a database it did not write.
//
// The defect this exists to prevent has a name in this repository: "208
// positions but only 10 transaction hashes". Two true numbers, no stated
// relationship, and a reader left to assume the worse one was a bug or the
// better one was a lie. So the tests below are mostly about the FOUR COUNTS
// staying four counts — decisions, lots, execution attempts, confirmed
// transactions — and about the document never inflating one with another.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { haveDatabase, seedPortfolio, truncateAll, withSchema } from "../db/testing.js";
import { query } from "../db/pool.js";
import { buildPortfolioProof } from "./portfolio.js";
import { PostgresExecutionLedger } from "../ledger/postgres.js";
import { PostgresDecisionLog, PostgresStateStore } from "../store/postgres.js";
import type { ReceiptReader } from "../runtime/receipt.js";
import type { DecisionRecord, HeldPosition } from "../runtime/state.js";

/** A chain that answers, so the proof's "confirmed" column means something. */
const chainSays = (map: Record<string, { ok: boolean; blockNumber: number }>): ReceiptReader => ({
  receipt: async (h) => map[h] ?? null,
});

const decision = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  at: 1_800_000_000,
  cycle: 1,
  marketId: "0xmarket1",
  asset: "BTC",
  intervalSec: 900,
  leg: "UP",
  action: "SKIP",
  fair: 0.55,
  ask: 0.5,
  edge: 0.05,
  shares: 0,
  cost: 0,
  binding: "BTC delta budget ±2.50/1%",
  ...over,
});

const held = (over: Partial<HeldPosition> = {}): HeldPosition => ({
  marketId: "0xmarket1",
  asset: "BTC",
  intervalSec: 900,
  leg: "UP",
  shares: 10,
  entryPrice: 0.4,
  cost: 4,
  expiry: 1_800_003_600,
  deltaPer1PctPerShare: 0.02,
  openedAt: 1_800_000_000,
  fairAtEntry: 0.5,
  ...over,
});

describe.skipIf(!haveDatabase())("the portfolio proof", () => {
  let teardown: () => Promise<void>;
  let portfolioId = "";

  beforeAll(async () => {
    teardown = await withSchema("proof");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll();
    portfolioId = (await seedPortfolio()).portfolioId;
  });

  it("refuses to invent a portfolio", async () => {
    await expect(buildPortfolioProof("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/no portfolio/);
  });

  it("reports an untouched portfolio as unproven rather than as zero success", async () => {
    const proof = await buildPortfolioProof(portfolioId, { reader: chainSays({}) });
    expect(proof.counts.decisions).toBe(0);
    expect(proof.counts.executionAttempts).toBe(0);
    expect(proof.counts.confirmedOnChain).toBe(0);
    const unproven = proof.stages.filter((s) => !s.proven).map((s) => s.name);
    expect(unproven).toContain("DISCOVER");
    expect(unproven).toContain("BROADCAST");
    // PERSIST and RISK CHECK are true of an empty portfolio and say so.
    expect(proof.stages.find((s) => s.name === "PERSIST")?.proven).toBe(true);
  });

  it("keeps decisions, lots, attempts and confirmations as four different numbers", async () => {
    // The whole point. These are related and none is a proxy for another.
    const log = new PostgresDecisionLog(portfolioId);
    await log.append([
      decision(),
      decision({ leg: "DOWN", binding: "edge -0.02 below floor" }),
      decision({ action: "BUY", shares: 10, cost: 4, binding: "kelly" }),
    ]);

    const store = new PostgresStateStore(portfolioId);
    const state = await store.load();
    state.open.push(held(), held({ marketId: "0xmarket2", cost: 3, shares: 6 }));
    state.cash -= 7;
    await store.save(state);

    const ledger = new PostgresExecutionLedger();
    const a = await ledger.intend({
      portfolioId, idempotencyKey: "1:BUY:0xmarket1:UP", cycle: 1,
      marketId: "0xmarket1", action: "BUY", leg: "UP", mode: "live",
    });
    await ledger.submitted(a.id, "0xconfirmed");
    await ledger.confirmed(a.id, { filledQty: 10, filledPrice: 0.4, cost: 4 });
    const b = await ledger.intend({
      portfolioId, idempotencyKey: "1:BUY:0xmarket2:UP", cycle: 1,
      marketId: "0xmarket2", action: "BUY", leg: "UP", mode: "live",
    });
    await ledger.failed(b.id, "lot size");
    const c = await ledger.intend({
      portfolioId, idempotencyKey: "1:CLAIM:sweep:-", cycle: 1,
      marketId: "sweep", action: "CLAIM", mode: "live",
    });
    await ledger.confirmed(c.id, { filledQty: 0, filledPrice: 1, cost: 0 });

    const proof = await buildPortfolioProof(portfolioId, {
      reader: chainSays({ "0xconfirmed": { ok: true, blockNumber: 1234 } }),
    });

    expect(proof.counts.decisions).toBe(3);
    expect(proof.counts.decisionsEntered).toBe(1);
    expect(proof.counts.decisionsRefused).toBe(2);
    expect(proof.counts.lotsOpen).toBe(2);
    expect(proof.counts.lotsClosed).toBe(0);
    expect(proof.counts.executionAttempts).toBe(3);
    expect(proof.counts.executionsByStatus).toEqual({ confirmed: 2, failed: 1 });
    // One attempt reached the chain; one confirmed. Neither equals the lot count
    // and neither equals the decision count, which is exactly the property that
    // was missing before.
    expect(proof.counts.executionsWithTxHash).toBe(1);
    expect(proof.counts.confirmedOnChain).toBe(1);
  });

  it("verifies a hash against the chain rather than trusting the ledger", async () => {
    const ledger = new PostgresExecutionLedger();
    const row = await ledger.intend({
      portfolioId, idempotencyKey: "1:BUY:0xm:UP", cycle: 1,
      marketId: "0xm", action: "BUY", leg: "UP", mode: "live",
    });
    await ledger.submitted(row.id, "0xreverted");
    await ledger.confirmed(row.id, { filledQty: 1, filledPrice: 0.5, cost: 0.5 });

    // The ledger says confirmed; the chain says it reverted. The chain wins in
    // the proof, because the proof's job is to be checkable by a stranger.
    const proof = await buildPortfolioProof(portfolioId, {
      reader: chainSays({ "0xreverted": { ok: false, blockNumber: 9 } }),
    });
    expect(proof.counts.executionsWithTxHash).toBe(1);
    expect(proof.counts.confirmedOnChain).toBe(0);
    expect(proof.receipts[0]!.found).toBe(true);
    expect(proof.receipts[0]!.succeeded).toBe(false);
    expect(proof.stages.find((s) => s.name === "CONFIRM")?.proven).toBe(false);
  });

  it("does not call an unreachable RPC a failure", async () => {
    const ledger = new PostgresExecutionLedger();
    const row = await ledger.intend({
      portfolioId, idempotencyKey: "1:BUY:0xm:UP", cycle: 1,
      marketId: "0xm", action: "BUY", leg: "UP", mode: "live",
    });
    await ledger.submitted(row.id, "0xunknown");
    const proof = await buildPortfolioProof(portfolioId, { reader: chainSays({}) });
    expect(proof.receipts[0]!.found).toBe(false);
    expect(proof.receipts[0]!.succeeded).toBe(false);
    // Reported, not counted as evidence either way.
    expect(proof.counts.confirmedOnChain).toBe(0);
  });

  it("explains an absence of hashes when the portfolio is in Shadow Mode", async () => {
    // A dry run has decisions and lots and no transactions. That must read as a
    // mode, not as a failure to execute.
    const proof = await buildPortfolioProof(portfolioId, { reader: chainSays({}) });
    const broadcast = proof.stages.find((s) => s.name === "BROADCAST")!;
    expect(broadcast.proven).toBe(false);
    expect(broadcast.evidence).toMatch(/Shadow Mode/);
  });

  it("traces a closed position to the transactions that produced it", async () => {
    const ledger = new PostgresExecutionLedger();
    const open = await ledger.intend({
      portfolioId, idempotencyKey: "1:BUY:0xmarket1:UP", cycle: 1,
      marketId: "0xmarket1", action: "BUY", leg: "UP", mode: "live",
    });
    await ledger.submitted(open.id, "0xopen");
    await ledger.confirmed(open.id, { filledQty: 10, filledPrice: 0.4, cost: 4 });

    const store = new PostgresStateStore(portfolioId);
    const state = await store.load();
    state.open.push(held({ openedBy: open.id }));
    state.cash -= 4;
    await store.save(state);

    const exit = await ledger.intend({
      portfolioId, idempotencyKey: "2:EXIT:0xmarket1:UP", cycle: 2,
      marketId: "0xmarket1", action: "EXIT", leg: "UP", mode: "live",
    });
    await ledger.submitted(exit.id, "0xexit");
    await ledger.confirmed(exit.id, { filledQty: 10, filledPrice: 0.6, cost: -6 });

    const p = state.open.pop()!;
    state.closed.push({
      id: p.id!, closedBy: [exit.id],
      marketId: p.marketId, asset: p.asset, intervalSec: p.intervalSec, leg: p.leg,
      shares: p.shares, entryPrice: p.entryPrice, cost: p.cost, fairAtEntry: p.fairAtEntry,
      openedAt: p.openedAt, closedAt: 1_800_000_100, won: 0, proceeds: 6, exit: "sold",
    });
    state.cash += 6;
    state.realizedPnl += 2;
    await store.save(state);

    const proof = await buildPortfolioProof(portfolioId, {
      reader: chainSays({ "0xopen": { ok: true, blockNumber: 1 }, "0xexit": { ok: true, blockNumber: 2 } }),
    });
    expect(proof.positions.closed).toHaveLength(1);
    expect(proof.positions.closed[0]!.txHashes.sort()).toEqual(["0xexit", "0xopen"]);
    expect(proof.settlement.sold).toBe(1);
    expect(proof.counts.confirmedOnChain).toBe(2);
  });

  it("reports the ledger identity, and whether it holds", async () => {
    const store = new PostgresStateStore(portfolioId);
    const state = await store.load();
    state.open.push(held());
    state.cash -= 4;
    await store.save(state);
    const proof = await buildPortfolioProof(portfolioId, { reader: chainSays({}) });
    expect(proof.ledger.balances).toBe(true);
    expect(Math.abs(proof.ledger.imbalance)).toBeLessThan(1e-9);
    expect(proof.ledger.openCost).toBe(4);
    expect(proof.ledger.cash).toBe(46);
  });

  it("counts breaker and reconciliation events without mixing them into decisions", async () => {
    await query(
      `INSERT INTO events (portfolio_id, kind, severity, message) VALUES
        ($1, 'breaker.halted', 'error', 'drawdown'),
        ($1, 'reconcile.adopted', 'warn', 'chain held 3 we did not'),
        ($1, 'autopilot.enabled', 'info', 'on')`,
      [portfolioId],
    );
    const proof = await buildPortfolioProof(portfolioId, { reader: chainSays({}) });
    expect(proof.risk.breakerEvents).toBe(1);
    expect(proof.reconciliation.events).toBe(1);
    // `info` is not something that needed attention, so it stays out of the risk
    // list — otherwise "3 events" would mean nothing.
    expect(proof.risk.events.map((e) => e.kind).sort()).toEqual(["breaker.halted", "reconcile.adopted"]);
    expect(proof.counts.decisions).toBe(0);
  });

  it("keeps portfolios apart", async () => {
    const other = await seedPortfolio();
    await new PostgresDecisionLog(portfolioId).append([decision(), decision()]);
    const mine = await buildPortfolioProof(portfolioId, { reader: chainSays({}) });
    const theirs = await buildPortfolioProof(other.portfolioId, { reader: chainSays({}) });
    expect(mine.counts.decisions).toBe(2);
    expect(theirs.counts.decisions).toBe(0);
  });
});
