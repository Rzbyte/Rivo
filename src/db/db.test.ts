// The durable layer, against a real PostgreSQL.
//
// Skipped when DATABASE_URL is absent, which is why the rest of the suite still
// runs anywhere. `npx tsx scripts/dev-postgres.ts start` gets one in about
// twenty seconds without Docker or root.
//
// What these are actually for: every property here is a property of the SERVER,
// not of this code. A partial unique index, `FOR UPDATE SKIP LOCKED`, a
// conditional UPDATE returning zero rows, an optimistic version check. Testing
// them against an emulator would test the emulator.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { haveDatabase, seedPortfolio, truncateAll, withSchema } from "./testing.js";
import { query } from "./pool.js";
import { claim, claimDue, held, heartbeat, liveWorkers, registerWorker, release, releaseAll, renew } from "./leases.js";
import { createPortfolio, mayTradeLive, portfolioById, portfolioOf, portfoliosOf, scheduleNext, setState, updatePolicy } from "./portfolios.js";
import { eraseUser, setDelegated, upsertUser, upsertWallet, walletsOf } from "./accounts.js";
import { PostgresDecisionLog, PostgresStateStore } from "../store/postgres.js";
import { PostgresExecutionLedger } from "../ledger/postgres.js";
import { closedPositions } from "./view.js";
import { StaleStateError } from "../store/types.js";
import { emptyState, ledgerBalances, type HeldPosition, type RivoState } from "../runtime/state.js";

describe.skipIf(!haveDatabase())("the durable layer", () => {
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    teardown = await withSchema("core");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(truncateAll);

  describe("accounts", () => {
    it("is idempotent on a repeated login", async () => {
      const a = await upsertUser("did:privy:abc", "x@example.com");
      const b = await upsertUser("did:privy:abc");
      expect(b.id).toBe(a.id);
      // A login method that carries no email must not erase the one we had.
      expect(b.email).toBe("x@example.com");
      expect(b.lastSeenAt).toBeGreaterThanOrEqual(a.lastSeenAt);
    });

    it("accepts a portfolio wallet before it has a way to sign, and refuses to call it delegated", async () => {
      // Privy issues a wallet id only once the user delegates, so the wallet the
      // browser just created legitimately has an address and nothing else.
      const u = await upsertUser("did:privy:nosign");
      const w = await upsertWallet({ userId: u.id, address: "0x2222222222222222222222222222222222222222", kind: "portfolio" });
      expect(w.privyWalletId).toBeNull();
      expect(w.delegated).toBe(false);
      // But a row that claims Rivo may sign, with nothing to sign through, is a
      // lie the database refuses to store.
      await expect(query("UPDATE wallets SET delegated = true WHERE id = $1", [w.id])).rejects.toThrow();
    });

    it("stores addresses lowercased, and refuses anything else", async () => {
      const u = await upsertUser("did:privy:case");
      const w = await upsertWallet({ userId: u.id, address: "0xAABBCCDDEEFF00112233445566778899AABBCCDD", kind: "external" });
      expect(w.address).toBe("0xaabbccddeeff00112233445566778899aabbccdd");
      await expect(
        query("INSERT INTO wallets (user_id, address, kind) VALUES ($1, '0xAA', 'external')", [u.id]),
      ).rejects.toThrow();
    });

    it("grants and revokes signing authority, scoped to the owner", async () => {
      const { userId, walletId } = await seedPortfolio();
      const other = await upsertUser("did:privy:intruder");
      // Someone else's id must not be able to touch this wallet.
      expect(await setDelegated(other.id, walletId, false)).toBeNull();
      const revoked = await setDelegated(userId, walletId, false);
      expect(revoked?.delegated).toBe(false);
      expect(revoked?.revokedAt).toBeGreaterThan(0);
      const granted = await setDelegated(userId, walletId, true);
      expect(granted?.delegated).toBe(true);
      expect(granted?.revokedAt).toBeNull();
    });

    it("erases an account completely, once erasure is declared", async () => {
      const { userId, portfolioId } = await seedPortfolio();
      await new PostgresDecisionLog(portfolioId).append([
        { at: 1, cycle: 1, marketId: "0xm", asset: "BTC", intervalSec: 900, leg: "UP", action: "SKIP", fair: 0.5, ask: 0.4, edge: 0.1, shares: 0, cost: 0, binding: "BTC delta budget" },
      ]);
      await eraseUser(userId);
      expect(await walletsOf(userId)).toHaveLength(0);
      const left = await query<{ n: string }>("SELECT count(*)::text AS n FROM decisions");
      expect(left[0]!.n).toBe("0");
    });
  });

  describe("portfolios", () => {
    it("hides one user's portfolio from another", async () => {
      const { userId, portfolioId } = await seedPortfolio();
      const other = await upsertUser("did:privy:other");
      expect(await portfolioOf(userId, portfolioId)).not.toBeNull();
      expect(await portfolioOf(other.id, portfolioId)).toBeNull();
      expect(await portfoliosOf(other.id)).toHaveLength(0);
      expect(await updatePolicy(other.id, portfolioId, { capital: 9999 })).toBeNull();
      // Unchanged, because the update found nothing.
      expect((await portfolioById(portfolioId))?.policy.capital).toBe(50);
    });

    it("creates its runtime row and its lease row with it", async () => {
      const u = await upsertUser("did:privy:new");
      const w = await upsertWallet({ userId: u.id, address: "0x1111111111111111111111111111111111111111", kind: "portfolio", privyWalletId: "pw1" });
      const p = await createPortfolio({ userId: u.id, walletId: w.id, network: "testnet", capital: 100, profile: "conservative" });
      expect(p.policy.state).toBe("idle");
      const rt = await query("SELECT cash FROM portfolio_runtime WHERE portfolio_id = $1", [p.id]);
      expect(rt).toHaveLength(1);
      const lease = await query("SELECT fence FROM portfolio_leases WHERE portfolio_id = $1", [p.id]);
      expect(lease).toHaveLength(1);
    });

    it("will not let a saved settings form un-halt a portfolio", async () => {
      const { userId, portfolioId } = await seedPortfolio();
      await setState(userId, portfolioId, "halted", "drawdown breaker");
      await updatePolicy(userId, portfolioId, { capital: 75, profile: "active" });
      const p = await portfolioById(portfolioId);
      expect(p?.policy.state).toBe("halted");
      expect(p?.policy.capital).toBe(75);
    });

    it("only permits live trading when the user asked AND the wallet is still delegated", async () => {
      const { userId, walletId, portfolioId } = await seedPortfolio({ mode: "autopilot" });
      expect(mayTradeLive((await portfolioById(portfolioId))!)).toBe(true);
      // Revoking in Privy has to stop trading even if nothing told Rivo, so the
      // check reads current state rather than a flag Rivo set once.
      await setDelegated(userId, walletId, false);
      expect(mayTradeLive((await portfolioById(portfolioId))!)).toBe(false);
    });

    it("tightens overrides through parsePolicy rather than trusting the column", async () => {
      const { userId, portfolioId } = await seedPortfolio();
      await updatePolicy(userId, portfolioId, { overrides: { maxPerPosition: 0.02, nonsense: 1 } as never });
      const p = await portfolioById(portfolioId);
      expect(p?.policy.overrides.maxPerPosition).toBe(0.02);
      expect((p?.policy.overrides as Record<string, unknown>).nonsense).toBeUndefined();
    });
  });

  describe("leases", () => {
    const worker = () => registerWorker("test-host", process.pid, "test");

    it("gives one portfolio to exactly one of two racing workers", async () => {
      const { portfolioId } = await seedPortfolio();
      const [a, b] = await Promise.all([worker(), worker()]);
      const [first, second] = await Promise.all([claimDue(a.id, 10), claimDue(b.id, 10)]);
      const winners = [...first, ...second];
      expect(winners).toHaveLength(1);
      expect(winners[0]!.portfolioId).toBe(portfolioId);
    });

    it("does not offer a portfolio that is not running", async () => {
      const { portfolioId } = await seedPortfolio({ state: "paused" });
      const w = await worker();
      expect(await claimDue(w.id)).toHaveLength(0);
      await setState(null, portfolioId, "running");
      expect(await claimDue(w.id)).toHaveLength(1);
    });

    it("does not offer a portfolio that is not due yet", async () => {
      const { portfolioId } = await seedPortfolio();
      await scheduleNext(portfolioId, 3600);
      const w = await worker();
      expect(await claimDue(w.id)).toHaveLength(0);
    });

    it("hands a lease on to the next worker once it expires", async () => {
      const { portfolioId } = await seedPortfolio();
      const a = await worker();
      const b = await worker();
      const [lease] = await claimDue(a.id, 10, 1);
      expect(lease).toBeDefined();
      expect(await claimDue(b.id, 10, 60)).toHaveLength(0);
      await query("UPDATE portfolio_leases SET expires_at = now() - interval '1 second' WHERE portfolio_id = $1", [
        portfolioId,
      ]);
      const taken = await claimDue(b.id, 10, 60);
      expect(taken).toHaveLength(1);
      // The fence moved, which is what makes the handover safe.
      expect(taken[0]!.fence).toBeGreaterThan(lease!.fence);
    });

    it("REFUSES a stale worker that wakes up believing it still holds the lease", async () => {
      // The scenario a plain timeout does not fix: A stalls, its lease expires,
      // B takes it, then A comes back. A must not be able to renew, release, or
      // believe it is held.
      const { portfolioId } = await seedPortfolio();
      const a = await worker();
      const b = await worker();
      const [stale] = await claimDue(a.id, 10, 1);
      await query("UPDATE portfolio_leases SET expires_at = now() - interval '1 second' WHERE portfolio_id = $1", [
        portfolioId,
      ]);
      const [fresh] = await claimDue(b.id, 10, 60);

      expect(await renew(stale!)).toBe(false);
      expect(await held(stale!)).toBe(false);
      await release(stale!);
      // B's lease survived A's release attempt.
      expect(await held(fresh!)).toBe(true);
    });

    it("renews while it is ours and stops when it is not", async () => {
      const { portfolioId } = await seedPortfolio();
      const w = await worker();
      const [lease] = await claimDue(w.id, 10, 60);
      expect(await renew(lease!)).toBe(true);
      await release(lease!);
      expect(await renew(lease!)).toBe(false);
      // Released means immediately available again, without waiting out the TTL.
      const other = await worker();
      expect(await claim(other.id, portfolioId)).not.toBeNull();
    });

    it("releases everything on shutdown", async () => {
      await seedPortfolio();
      await seedPortfolio();
      const w = await worker();
      expect(await claimDue(w.id, 10)).toHaveLength(2);
      expect(await releaseAll(w.id)).toBe(2);
      const other = await worker();
      expect(await claimDue(other.id, 10)).toHaveLength(2);
    });

    it("distinguishes a dead fleet from an idle one", async () => {
      const w = await worker();
      await heartbeat(w.id, "cycle ok");
      expect((await liveWorkers()).map((x) => x.id)).toContain(w.id);
      await query("UPDATE workers SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [w.id]);
      expect((await liveWorkers()).map((x) => x.id)).not.toContain(w.id);
    });
  });

  describe("the state store", () => {
    const held1 = (over: Partial<HeldPosition> = {}): HeldPosition => ({
      marketId: "0xmarket1",
      asset: "BTC",
      intervalSec: 900,
      leg: "UP",
      shares: 10,
      entryPrice: 0.4,
      cost: 4,
      expiry: 1_800_000_000,
      deltaPer1PctPerShare: 0.02,
      openedAt: 1_799_999_000,
      fairAtEntry: 0.5,
      ...over,
    });

    it("round-trips a portfolio through a restart", async () => {
      const { portfolioId } = await seedPortfolio({ capital: 50 });
      const store = new PostgresStateStore(portfolioId);
      const state = await store.load();
      expect(state.capital).toBe(50);
      expect(state.cash).toBe(50);

      state.open.push(held1());
      state.cash -= 4;
      state.cycles = 3;
      state.tradedBy = "0xabc";
      state.lastTradedAt = { "0xmarket1:UP": 1_799_999_000 };
      await store.save(state);

      // A brand new store, as a restarted worker would build.
      const reloaded = await new PostgresStateStore(portfolioId).load();
      expect(reloaded.cash).toBe(46);
      expect(reloaded.cycles).toBe(3);
      expect(reloaded.tradedBy).toBe("0xabc");
      expect(reloaded.open).toHaveLength(1);
      expect(reloaded.open[0]!.shares).toBe(10);
      expect(reloaded.open[0]!.id).toBeDefined();
      expect(reloaded.lastTradedAt?.["0xmarket1:UP"]).toBe(1_799_999_000);
      expect(ledgerBalances(reloaded)).toBe(true);
    });

    it("keeps a settled position in the record, with what it paid out", async () => {
      const { portfolioId } = await seedPortfolio();
      const store = new PostgresStateStore(portfolioId);
      const state = await store.load();
      state.open.push(held1());
      state.cash -= 4;
      await store.save(state);

      const p = state.open.pop()!;
      state.closed.push({
        id: p.id!,
        marketId: p.marketId, asset: p.asset, intervalSec: p.intervalSec, leg: p.leg,
        shares: p.shares, entryPrice: p.entryPrice, cost: p.cost, fairAtEntry: p.fairAtEntry,
        openedAt: p.openedAt, closedAt: 1_800_000_100, won: 1, proceeds: 10, exit: "settled",
      });
      state.cash += 10;
      state.realizedPnl += 6;
      await store.save(state);

      const reloaded = await new PostgresStateStore(portfolioId).load();
      expect(reloaded.open).toHaveLength(0);
      expect(reloaded.closed).toHaveLength(1);
      expect(reloaded.closed[0]!.exit).toBe("settled");
      expect(reloaded.closed[0]!.proceeds).toBe(10);
      expect(reloaded.realizedPnl).toBe(6);
      expect(ledgerBalances(reloaded)).toBe(true);
      // One row, closed — not a second row alongside an open one.
      const rows = await query<{ n: string }>("SELECT count(*)::text AS n FROM positions WHERE portfolio_id = $1", [portfolioId]);
      expect(rows[0]!.n).toBe("1");
    });

    it("REFUSES a save whose snapshot is no longer current", async () => {
      const { portfolioId } = await seedPortfolio();
      const a = new PostgresStateStore(portfolioId);
      const b = new PostgresStateStore(portfolioId);
      const sa = await a.load();
      const sb = await b.load();
      sa.cycles = 1;
      await a.save(sa);
      sb.cycles = 99;
      await expect(b.save(sb)).rejects.toThrow(StaleStateError);
      // A's write survived, which is the whole point.
      expect((await new PostgresStateStore(portfolioId).load()).cycles).toBe(1);
    });

    it("keeps several lots of one leg, because the engine does", async () => {
      // The regression this exists for. A partial UNIQUE index on
      // (portfolio, market, leg) looked like an invariant worth enforcing and
      // was the opposite: the allocator tops a leg up by adding a LOT, each
      // with the price it was actually filled at, and the upsert against that
      // index overwrote the first lot with the second. The portfolio lost a
      // position's cost on every reload — three ledger repairs in forty live
      // cycles, drifting negative — and because each cycle reloads from the
      // database, the allocator saw less exposure than it held and kept buying.
      const { portfolioId } = await seedPortfolio();
      const store = new PostgresStateStore(portfolioId);
      const state = await store.load();

      state.open.push(held1({ shares: 10, cost: 4, entryPrice: 0.4 }));
      state.cash -= 4;
      await store.save(state);

      // A top-up: same market, same leg, a different fill price.
      state.open.push(held1({ shares: 5, cost: 2.5, entryPrice: 0.5 }));
      state.cash -= 2.5;
      await store.save(state);

      const reloaded = await new PostgresStateStore(portfolioId).load();
      expect(reloaded.open).toHaveLength(2);
      expect(reloaded.open.reduce((n, p) => n + p.shares, 0)).toBe(15);
      expect(reloaded.open.reduce((n, p) => n + p.cost, 0)).toBe(6.5);
      // The identity that the lost lot was breaking.
      expect(ledgerBalances(reloaded)).toBe(true);
      expect(reloaded.contributed ?? 0).toBe(0);
    });

    it("does not renumber a lot it has already written", async () => {
      // Each lot keeps its row across saves, or the update path degenerates into
      // an insert and the position count grows every cycle.
      const { portfolioId } = await seedPortfolio();
      const store = new PostgresStateStore(portfolioId);
      const state = await store.load();
      state.open.push(held1());
      state.cash -= 4;
      await store.save(state);
      const firstId = state.open[0]!.id;
      state.open[0]!.shares = 12;
      await store.save(state);
      await store.save(state);
      expect(state.open[0]!.id).toBe(firstId);
      const reloaded = await new PostgresStateStore(portfolioId).load();
      expect(reloaded.open).toHaveLength(1);
      expect(reloaded.open[0]!.shares).toBe(12);
    });

    it("records a position dropped by reconciliation rather than deleting it", async () => {
      const { portfolioId } = await seedPortfolio();
      const store = new PostgresStateStore(portfolioId);
      const state = await store.load();
      state.open.push(held1());
      state.cash -= 4;
      await store.save(state);
      const p = state.open.pop()!;
      state.contributed = (state.contributed ?? 0) - p.cost;
      state.closed.push({
        id: p.id!, marketId: p.marketId, asset: p.asset, intervalSec: p.intervalSec, leg: p.leg,
        shares: p.shares, entryPrice: p.entryPrice, cost: p.cost, fairAtEntry: p.fairAtEntry,
        openedAt: p.openedAt, closedAt: 1_800_000_000, won: 0, proceeds: 0, exit: "dropped",
      });
      await store.save(state);
      const reloaded = await new PostgresStateStore(portfolioId).load();
      expect(reloaded.closed[0]!.exit).toBe("dropped");
      expect(ledgerBalances(reloaded)).toBe(true);
    });

    it("keeps the remainder of a partially sold position", async () => {
      // The regression. A REDUCE records a closed entry for the slice that was
      // sold while the position stays open carrying the same id, so closing the
      // row on the id alone deleted the surviving lot. Live run: one REDUCE of
      // 0.66 shares, and the next cycle repaired the ledger by -0.31 — exactly
      // the remainder's cost.
      const { portfolioId } = await seedPortfolio();
      const store = new PostgresStateStore(portfolioId);
      const state = await store.load();
      state.open.push(held1({ shares: 10, cost: 4 }));
      state.cash -= 4;
      await store.save(state);

      const p = state.open[0]!;
      const soldShares = 4;
      const soldCost = 1.6;
      p.shares -= soldShares;
      p.cost -= soldCost;
      state.cash += 2;
      state.realizedPnl += 2 - soldCost;
      state.closed.push({
        id: p.id!,
        marketId: p.marketId, asset: p.asset, intervalSec: p.intervalSec, leg: p.leg,
        shares: soldShares, entryPrice: p.entryPrice, cost: soldCost, fairAtEntry: p.fairAtEntry,
        openedAt: p.openedAt, closedAt: 1_800_000_100, won: 0, proceeds: 2, exit: "sold",
      });
      await store.save(state);

      const reloaded = await new PostgresStateStore(portfolioId).load();
      expect(reloaded.open).toHaveLength(1);
      expect(reloaded.open[0]!.shares).toBe(6);
      expect(reloaded.open[0]!.cost).toBeCloseTo(2.4, 8);
      expect(reloaded.closed).toHaveLength(1);
      expect(reloaded.closed[0]!.shares).toBe(4);
      // The identity the lost remainder was breaking.
      expect(ledgerBalances(reloaded)).toBe(true);
      expect(reloaded.contributed ?? 0).toBe(0);
    });

    it("links a closed position to the executions that produced it", async () => {
      // The audit trail. This is what the execution ledger was built for: a
      // position that no longer exists still names the transactions that opened
      // and ended it, because the ledger rows outlive it.
      const { portfolioId } = await seedPortfolio();
      const ledger = new PostgresExecutionLedger();
      const opened = await ledger.intend({
        portfolioId, idempotencyKey: "1:BUY:0xmarket1:UP", cycle: 1,
        marketId: "0xmarket1", action: "BUY", leg: "UP", mode: "live",
      });
      await ledger.submitted(opened.id, "0xopenhash");
      await ledger.confirmed(opened.id, { filledQty: 10, filledPrice: 0.4, cost: 4 });

      const store = new PostgresStateStore(portfolioId);
      const state = await store.load();
      state.open.push(held1({ openedBy: opened.id }));
      state.cash -= 4;
      await store.save(state);

      const sold = await ledger.intend({
        portfolioId, idempotencyKey: "2:EXIT:0xmarket1:UP", cycle: 2,
        marketId: "0xmarket1", action: "EXIT", leg: "UP", mode: "live",
      });
      await ledger.submitted(sold.id, "0xexithash");
      await ledger.confirmed(sold.id, { filledQty: 10, filledPrice: 0.6, cost: -6 });

      const p = state.open.pop()!;
      state.closed.push({
        id: p.id!, closedBy: [sold.id],
        marketId: p.marketId, asset: p.asset, intervalSec: p.intervalSec, leg: p.leg,
        shares: p.shares, entryPrice: p.entryPrice, cost: p.cost, fairAtEntry: p.fairAtEntry,
        openedAt: p.openedAt, closedAt: 1_800_000_100, won: 0, proceeds: 6, exit: "sold",
      });
      state.cash += 6;
      state.realizedPnl += 2;
      await store.save(state);

      const [closed] = await closedPositions(portfolioId);
      expect(closed).toBeDefined();
      expect(closed!.exit).toBe("sold");
      expect(closed!.txHashes.sort()).toEqual(["0xexithash", "0xopenhash"]);
    });

    it("keeps decisions, in order, per portfolio", async () => {
      const a = await seedPortfolio();
      const b = await seedPortfolio();
      const log = new PostgresDecisionLog(a.portfolioId);
      await log.append([
        { at: 100, cycle: 1, marketId: "0xm1", asset: "BTC", intervalSec: 900, leg: "UP", action: "SKIP", fair: 0.55, ask: 0.5, edge: 0.05, shares: 0, cost: 0, binding: "BTC delta budget" },
        { at: 101, cycle: 1, marketId: "0xm2", asset: "BTC", intervalSec: 3600, leg: "UP", action: "ENTER", fair: 0.6, ask: 0.48, edge: 0.12, shares: 10, cost: 4.8, binding: "kelly" },
      ]);
      const read = await log.read();
      expect(read).toHaveLength(2);
      expect(read[0]!.binding).toBe("BTC delta budget");
      expect(read[1]!.action).toBe("ENTER");
      expect(await log.count()).toBe(2);
      expect(await new PostgresDecisionLog(b.portfolioId).count()).toBe(0);
    });

    it("hands the cycle a bounded window of history without losing any", async () => {
      const { portfolioId } = await seedPortfolio();
      const rows: string[] = [];
      const values: unknown[] = [];
      for (let i = 0; i < 20; i++) {
        const b = i * 3;
        rows.push(`($${b + 1}, '0xm${i}', 'BTC', 900, 'UP', 1, 0.5, 0.5, 0.5, now(), 'closed', $${b + 2}, false, 0, 'settled', $${b + 3})`);
        values.push(portfolioId, new Date(1_800_000_000_000 + i * 1000), new Date(1_800_000_000_000 + i * 1000));
      }
      await query(
        `INSERT INTO positions (portfolio_id, market_id, asset, interval_sec, leg, shares, entry_price, cost,
                                fair_at_entry, expiry, status, closed_at, won, proceeds, exit, opened_at)
         VALUES ${rows.join(", ")}`,
        values,
      );
      const state = await new PostgresStateStore(portfolioId).load();
      // Everything, here — the window is 500 — but ordered oldest-first as the
      // engine has always expected.
      expect(state.closed).toHaveLength(20);
      expect(state.closed[0]!.marketId).toBe("0xm0");
      expect(state.closed[19]!.marketId).toBe("0xm19");
    });
  });
});

// A guard on the guard: if someone deletes DATABASE_URL from CI, this file
// silently becomes zero assertions. Say so rather than passing quietly.
describe("database integration coverage", () => {
  it(haveDatabase() ? "is running against a real database" : "is SKIPPED — set DATABASE_URL to run it", () => {
    expect(true).toBe(true);
  });
});
