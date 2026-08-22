// The scheduler.
//
// Tested with the cycle runner replaced, deliberately. What is at stake in this
// file is not whether a trade is priced correctly — that is the engine's suite —
// it is whether the fleet can be trusted with many portfolios at once:
//
//   * one portfolio is run by one worker, never two;
//   * a failing portfolio does not take the others with it;
//   * a lease is released whatever happens, including a throw;
//   * a portfolio that fails is still scheduled to try again.
//
// None of those need a venue, a wallet or a signer, and requiring one would mean
// they never get exercised.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { haveDatabase, seedPortfolio, truncateAll, withSchema } from "../db/testing.js";
import { query } from "../db/pool.js";
import { Worker } from "./worker.js";
import type { CycleOutcome } from "./cycle.js";
import { setState } from "../db/portfolios.js";
import { claimDue, registerWorker } from "../db/leases.js";

describe.skipIf(!haveDatabase())("the worker", () => {
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    teardown = await withSchema("worker");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(truncateAll);

  /** A worker whose cycles are recorded rather than run. */
  const spyWorker = (
    seen: string[],
    behaviour: (id: string) => Promise<CycleOutcome> = async (id) => ({ portfolioId: id, ok: true }),
  ) =>
    new Worker({
      maxPasses: 1,
      idleMs: 1,
      concurrency: 8,
      out: () => {},
      runCycle: async (portfolio) => {
        seen.push(portfolio.id);
        return behaviour(portfolio.id);
      },
    });

  it("runs every portfolio that is due", async () => {
    const a = await seedPortfolio();
    const b = await seedPortfolio();
    const seen: string[] = [];
    await spyWorker(seen).start();
    expect(seen.sort()).toEqual([a.portfolioId, b.portfolioId].sort());
  });

  it("leaves paused and stopped portfolios alone", async () => {
    const running = await seedPortfolio();
    const paused = await seedPortfolio({ state: "paused" });
    const stopped = await seedPortfolio({ state: "stopped" });
    const halted = await seedPortfolio({ state: "halted" });
    const seen: string[] = [];
    await spyWorker(seen).start();
    expect(seen).toEqual([running.portfolioId]);
    expect(seen).not.toContain(paused.portfolioId);
    expect(seen).not.toContain(stopped.portfolioId);
    // Halted is the important one: a breaker fired, and nothing but a person
    // may restart it. A scheduler that treated 'halted' as runnable would undo
    // the breaker on the next tick.
    expect(seen).not.toContain(halted.portfolioId);
  });

  it("gives one portfolio to one worker even when two are running", async () => {
    await seedPortfolio();
    const seenA: string[] = [];
    const seenB: string[] = [];
    // Started together, against the same due portfolio.
    await Promise.all([spyWorker(seenA).start(), spyWorker(seenB).start()]);
    expect(seenA.length + seenB.length).toBe(1);
  });

  it("keeps going when one portfolio fails", async () => {
    const bad = await seedPortfolio();
    const good = await seedPortfolio();
    const seen: string[] = [];
    await spyWorker(seen, async (id) => {
      if (id === bad.portfolioId) throw new Error("indexer timeout");
      return { portfolioId: id, ok: true };
    }).start();
    expect(seen.sort()).toEqual([bad.portfolioId, good.portfolioId].sort());
  });

  it("releases the lease even when the cycle throws", async () => {
    const p = await seedPortfolio();
    await spyWorker([], async () => {
      throw new Error("boom");
    }).start();
    // The next worker can take it immediately, without waiting out the TTL.
    const next = await registerWorker("next", 1);
    expect(await claimDue(next.id)).toHaveLength(1);
    expect(p.portfolioId).toBeDefined();
  });

  it("releases everything it holds when it stops", async () => {
    await seedPortfolio();
    await seedPortfolio();
    await spyWorker([]).start();
    const rows = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM portfolio_leases WHERE released_at IS NULL AND expires_at > now()",
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("reports health that distinguishes started from working", async () => {
    await seedPortfolio();
    const w = spyWorker([]);
    expect(w.health.lastPassAt).toBe(0);
    await w.start();
    expect(w.health.passes).toBe(1);
    expect(w.health.cycles).toBe(1);
    expect(w.health.failures).toBe(0);
    expect(w.health.lastPassAt).toBeGreaterThan(0);
    expect(w.health.workerId).not.toBeNull();
  });

  it("counts a failed cycle as a failure without failing the pass", async () => {
    await seedPortfolio();
    const w = spyWorker([], async (id) => ({ portfolioId: id, ok: false, error: "no venue" }));
    await w.start();
    expect(w.health.cycles).toBe(1);
    expect(w.health.failures).toBe(1);
    expect(w.health.lastError).toBeNull(); // the PASS was fine; the cycle was not
  });

  it("does nothing, quietly, when the fleet has no work", async () => {
    const w = spyWorker([]);
    await w.start();
    expect(w.health.passes).toBe(1);
    expect(w.health.cycles).toBe(0);
    expect(w.health.failures).toBe(0);
  });

  it("takes a portfolio the moment it starts running, rather than at the next interval", async () => {
    const p = await seedPortfolio({ state: "idle" });
    const before: string[] = [];
    await spyWorker(before).start();
    expect(before).toHaveLength(0);

    await setState(null, p.portfolioId, "running");
    const after: string[] = [];
    await spyWorker(after).start();
    expect(after).toEqual([p.portfolioId]);
  });
});
