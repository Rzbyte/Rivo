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
import { Worker, VENUE_DOWN_AFTER } from "./worker.js";
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

  it("never lets two workers hold one portfolio at the same time", async () => {
    // The property that matters is CONCURRENT exclusion, not "only one worker
    // ever touches it" — two workers running a portfolio one after the other is
    // the fleet working correctly, and an earlier version of this test asserted
    // the wrong thing and passed only because the spy cycle returned instantly.
    //
    // So the cycle is held open. Whichever worker claims first is still inside
    // its pass when the other asks, and the other must come away with nothing.
    await seedPortfolio();
    const seenA: string[] = [];
    const seenB: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const hold = (seen: string[]) =>
      new Worker({
        maxPasses: 1,
        idleMs: 1,
        out: () => {},
        runCycle: async (portfolio) => {
          seen.push(portfolio.id);
          await gate;
          return { portfolioId: portfolio.id, ok: true };
        },
      });

    const a = hold(seenA).start();
    const b = hold(seenB).start();

    // Wait for one of them to be inside the cycle, holding the lease.
    const deadline = Date.now() + 5_000;
    while (seenA.length + seenB.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seenA.length + seenB.length).toBe(1);

    open();
    await Promise.all([a, b]);
    // Still one: the loser's single pass found a portfolio it could not claim
    // and finished without it.
    expect(seenA.length + seenB.length).toBe(1);
  });

  it("hands a portfolio on to the next worker once the first is done with it", async () => {
    // The other half, and the reason the test above had to be rewritten rather
    // than tightened: sequential handover is correct and must keep working.
    const { portfolioId } = await seedPortfolio();
    const first: string[] = [];
    await spyWorker(first).start();
    expect(first).toEqual([portfolioId]);
    const second: string[] = [];
    await spyWorker(second).start();
    expect(second).toEqual([portfolioId]);
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

  it("tells a ticking process apart from one getting work done", async () => {
    // The distinction a health endpoint must not lose. A worker whose cycles all
    // fail is still passing, still heartbeating, and doing nothing.
    await seedPortfolio();
    const good = spyWorker([]);
    await good.start();
    expect(good.health.lastSuccessfulCycleAt).toBeGreaterThan(0);
    expect(good.health.consecutiveCycleFailures).toBe(0);

    const bad = spyWorker([], async (id) => ({ portfolioId: id, ok: false, error: "indexer down" }));
    await bad.start();
    expect(bad.health.lastSuccessfulCycleAt).toBe(0);
    expect(bad.health.consecutiveCycleFailures).toBe(1);
    expect(bad.health.passes).toBe(1); // the PASS was fine
  });

  it("reports the venue as unreachable only after a run of failures", async () => {
    // One bad indexer response is not news — the Indexer already retries. Every
    // portfolio failing repeatedly is the venue, and deserves waking somebody.
    await seedPortfolio();
    const w = new Worker({
      maxPasses: VENUE_DOWN_AFTER + 2,
      idleMs: 1,
      out: () => {},
      runCycle: async (portfolio) => ({ portfolioId: portfolio.id, ok: false, error: "ECONNREFUSED" }),
    });
    await w.start();
    expect(w.health.consecutiveCycleFailures).toBeGreaterThanOrEqual(VENUE_DOWN_AFTER);

    const events = await query<{ kind: string; portfolio_id: string | null; message: string }>(
      "SELECT kind, portfolio_id, message FROM events WHERE kind = 'venue.unreachable'",
    );
    expect(events).toHaveLength(1);
    // Against no portfolio: it is not one portfolio's problem.
    expect(events[0]!.portfolio_id).toBeNull();
    expect(events[0]!.message).toContain("ECONNREFUSED");
  });

  it("clears the failure run as soon as one cycle works", async () => {
    await seedPortfolio();
    let fail = true;
    const w = new Worker({
      maxPasses: 4,
      idleMs: 1,
      out: () => {},
      runCycle: async (portfolio) => {
        const ok = !fail;
        fail = false;
        return ok ? { portfolioId: portfolio.id, ok: true } : { portfolioId: portfolio.id, ok: false, error: "blip" };
      },
    });
    await w.start();
    expect(w.health.consecutiveCycleFailures).toBe(0);
    expect(w.health.lastSuccessfulCycleAt).toBeGreaterThan(0);
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
