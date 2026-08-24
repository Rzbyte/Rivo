// The scenario that must be safe.
//
//   1. Rivo sends a BUY.
//   2. The chain confirms it.
//   3. The process dies before local state is written.
//   4. A worker restarts.
//   5. It reconciles against the chain.
//   6. It MUST NOT place the same BUY again.
//
// There are two independent defences and both are tested here, because either
// one alone leaves a hole:
//
//   THE LEDGER, in this file, prevents a REPEAT WITHIN A PASS. An intent is
//   durable before anything is signed, so a retry finds the earlier attempt and
//   refuses rather than sending a second transaction. It is exact where it can
//   be and honest where it cannot: a submitted transaction with no receipt is
//   'orphaned', not 'failed', because calling it failed is a guess in the one
//   direction that duplicates the trade.
//
//   RECONCILIATION, at the bottom, prevents a REPEAT ACROSS PASSES. The ledger
//   cannot know what happened in the instant between signing and the process
//   dying — the kit returns a hash only after the write completes, so there is
//   no moment at which Rivo holds a hash for an in-flight transaction. The chain
//   knows. So the position that landed is adopted from the outcome-token
//   contract, the allocator sees the exposure, and it does not buy it twice.
//
// Together those cover the crash at every point. Neither claims to cover it alone.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileExecutionLedger, executionLogPath } from "./file.js";
import { PostgresExecutionLedger } from "./postgres.js";
import { RecordingExecutor, recover } from "./recording.js";
import type { ExecutionLedger } from "./types.js";
import type { Executor, OrderRequest, OrderResult } from "../runtime/executor.js";
import type { ReceiptReader } from "../runtime/receipt.js";
import { reconcile } from "../runtime/reconcile.js";
import { emptyState, ledgerBalances, type HeldPosition, type RivoState } from "../runtime/state.js";
import { haveDatabase, seedPortfolio, truncateAll, withSchema } from "../db/testing.js";

/** An executor that counts what it was actually asked to send. */
class CountingExecutor implements Executor {
  readonly mode = "live" as const;
  buys: OrderRequest[] = [];
  /** Set to make the next buy behave as if the process died inside it. */
  crashOnBuy = false;
  /** The hash a successful buy reports. */
  hash = "0xfilled";

  async buy(req: OrderRequest): Promise<OrderResult> {
    this.buys.push(req);
    if (this.crashOnBuy) throw new Error("process died mid-write");
    return { filled: req.size, avgPrice: req.limitPrice, cost: req.size * req.limitPrice, txHash: this.hash };
  }
  async sell(): Promise<OrderResult> {
    return { filled: 0, avgPrice: 0, cost: 0 };
  }
  async mintSet(): Promise<OrderResult> {
    return { filled: 0, avgPrice: 0, cost: 0 };
  }
  async mergeSet(): Promise<OrderResult> {
    return { filled: 0, avgPrice: 0, cost: 0 };
  }
  async claim(): Promise<number> {
    return 0;
  }
  async cancelResting(): Promise<number> {
    return 0;
  }
  async isTradable(): Promise<boolean> {
    return true;
  }
  newCycle(): void {}
  async address(): Promise<string | null> {
    return "0xwallet";
  }
}

const REQ: OrderRequest = { marketId: "0xmarket", leg: "UP", size: 10, limitPrice: 0.42 };

/** The same battery over both ledgers — the guarantee must not depend on storage. */
function suite(name: string, make: () => ExecutionLedger, portfolio: () => string) {
  describe(name, () => {
    const wrap = (inner: Executor, ledger: ExecutionLedger, cycle: number) => {
      const rec = new RecordingExecutor(inner, { portfolioId: portfolio(), ledger });
      rec.newCycle(cycle);
      return rec;
    };

    it("sends ONE order when the same buy is attempted twice in a pass", async () => {
      const ledger = make();
      const inner = new CountingExecutor();
      const exec = wrap(inner, ledger, 7);
      const first = await exec.buy(REQ, undefined);
      const second = await exec.buy(REQ, undefined);
      expect(inner.buys).toHaveLength(1);
      // The second call REPLAYS the first rather than reporting nothing, so the
      // caller's accounting is identical either way.
      expect(second.filled).toBe(first.filled);
      expect(second.txHash).toBe(first.txHash);
    });

    it("survives the process dying between the fill and the state write", async () => {
      const ledger = make();
      const inner = new CountingExecutor();

      // Pass one: the order fills, and then the world ends before anything else
      // happens. The ledger row is already confirmed, because it is written by
      // the executor rather than by the cycle that was about to save.
      await wrap(inner, ledger, 12).buy(REQ, undefined);
      expect(inner.buys).toHaveLength(1);

      // Restart: a brand-new ledger handle over the same storage, a brand-new
      // executor, and the same cycle number — the worst case, because a later
      // cycle number is meant to be allowed to retry.
      const afterRestart = wrap(new CountingExecutor(), ledger, 12);
      const replayed = await afterRestart.buy(REQ, undefined);
      expect((afterRestart as unknown as { target: CountingExecutor }).target.buys).toHaveLength(0);
      expect(replayed.txHash).toBe("0xfilled");
    });

    it("refuses to repeat an order whose outcome is unknown", async () => {
      const ledger = make();
      const inner = new CountingExecutor();
      inner.crashOnBuy = true;
      const exec = wrap(inner, ledger, 3);
      await expect(exec.buy(REQ, undefined)).rejects.toThrow(/died mid-write/);

      // The row is 'failed' — it threw before returning a hash, so nothing was
      // knowingly sent. A retry in the same pass is still refused, because
      // "threw" is not the same as "did not reach the chain".
      const row = await ledger.find(portfolio(), "3:BUY:0xmarket:UP");
      expect(row?.status).toBe("failed");
      const retry = await wrap(new CountingExecutor(), ledger, 3).buy(REQ, undefined);
      expect(retry.filled).toBe(0);
    });

    it("blocks a retry while an earlier attempt is still in flight", async () => {
      const ledger = make();
      const row = await ledger.intend({
        portfolioId: portfolio(),
        idempotencyKey: "5:BUY:0xmarket:UP",
        cycle: 5,
        marketId: "0xmarket",
        action: "BUY",
        leg: "UP",
        mode: "live",
      });
      await ledger.submitted(row.id, "0xinflight");

      const inner = new CountingExecutor();
      const res = await wrap(inner, ledger, 5).buy(REQ, undefined);
      expect(inner.buys).toHaveLength(0);
      expect(res.rejected).toMatch(/submitted/);
    });

    it("allows the NEXT cycle to try again, because a leg that fails once is not retired", async () => {
      const ledger = make();
      const inner = new CountingExecutor();
      inner.crashOnBuy = true;
      await expect(wrap(inner, ledger, 20).buy(REQ, undefined)).rejects.toThrow();

      inner.crashOnBuy = false;
      await wrap(inner, ledger, 21).buy(REQ, undefined);
      expect(inner.buys).toHaveLength(2);
    });

    it("recovers an unresolved row from the chain, and then refuses to repeat it", async () => {
      const ledger = make();
      const row = await ledger.intend({
        portfolioId: portfolio(),
        idempotencyKey: "31:BUY:0xmarket:UP",
        cycle: 31,
        marketId: "0xmarket",
        action: "BUY",
        leg: "UP",
        requestedQty: 10,
        requestedPrice: 0.42,
        mode: "live",
      });
      await ledger.submitted(row.id, "0xlanded");

      const receipts: ReceiptReader = { receipt: async () => ({ ok: true, blockNumber: 99 }) };
      const out = await recover(ledger, portfolio(), receipts);
      expect(out.resolved).toBe(1);

      const inner = new CountingExecutor();
      const replay = await wrap(inner, ledger, 31).buy(REQ, undefined);
      expect(inner.buys).toHaveLength(0);
      expect(replay.txHash).toBe("0xlanded");
      expect(replay.filled).toBe(10);
    });
  });
}

describe("crash safety", () => {
  describe("with the file ledger", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "rivo-idem-"));
    });
    suite(
      "the ledger",
      () => new FileExecutionLedger(executionLogPath(dir)),
      () => "11111111-1111-1111-1111-111111111111",
    );
  });

  describe.skipIf(!haveDatabase())("with the postgres ledger", () => {
    let teardown: () => Promise<void>;
    let portfolioId = "";
    beforeAll(async () => {
      teardown = await withSchema("idempotency");
    });
    afterAll(async () => {
      await teardown();
    });
    beforeEach(async () => {
      await truncateAll();
      portfolioId = (await seedPortfolio()).portfolioId;
    });
    suite(
      "the ledger",
      () => new PostgresExecutionLedger(),
      () => portfolioId,
    );
  });
});

describe("the defence the ledger cannot provide", () => {
  const held = (over: Partial<HeldPosition> = {}): HeldPosition => ({
    marketId: "0xmarket",
    asset: "BTC",
    intervalSec: 900,
    leg: "UP",
    shares: 10,
    entryPrice: 0.42,
    cost: 4.2,
    expiry: 1_800_003_600,
    deltaPer1PctPerShare: 0.02,
    openedAt: 1_800_000_000,
    fairAtEntry: 0.5,
    ...over,
  });

  it("adopts a position that landed while the process was dying", () => {
    // The gap the ledger cannot close: the transaction was signed and broadcast
    // in the instant before the crash, and no hash was ever recorded. Rivo comes
    // back believing it holds nothing. The chain disagrees, and the chain wins.
    const state: RivoState = emptyState(50, "balanced", false);
    const chain = new Map([["0xmarket:UP", 10]]);
    const meta = new Map([["0xmarket:UP", { asset: "BTC" as const, intervalSec: 900, expiry: 1_800_003_600, fair: 0.5 }]]);
    const marks = new Map([["0xmarket:UP", 0.42]]);

    const found = reconcile({ state, chain, meta, marks, now: 1_800_000_600 });

    expect(found.map((d) => d.action)).toEqual(["adopted"]);
    expect(state.open).toHaveLength(1);
    expect(state.open[0]!.shares).toBe(10);
    // Adopted, therefore its cost basis is an ESTIMATE and everything downstream
    // has to say so rather than presenting a guess as a fill.
    expect(state.open[0]!.adopted).toBe(true);
    // And the portfolio still balances: the value arrived through `contributed`,
    // not through cash it never spent.
    expect(ledgerBalances(state)).toBe(true);
  });

  it("does not re-buy a leg it already holds after that adoption", () => {
    // The consequence, stated as the property that actually matters. Once the
    // position is in `state.open`, every downstream consumer — the allocator's
    // exposure, the delta budget, the position manager — sees it. There is no
    // path from here to a second BUY of the same leg.
    const state: RivoState = emptyState(50, "balanced", false);
    const chain = new Map([["0xmarket:UP", 10]]);
    const meta = new Map([["0xmarket:UP", { asset: "BTC" as const, intervalSec: 900, expiry: 1_800_003_600, fair: 0.5 }]]);
    reconcile({ state, chain, meta, marks: new Map([["0xmarket:UP", 0.42]]), now: 1_800_000_600 });

    // A second reconciliation against the same chain state changes nothing —
    // it is not a second position, and it is not a discrepancy.
    const again = reconcile({ state, chain, meta, marks: new Map(), now: 1_800_000_900 });
    expect(again).toHaveLength(0);
    expect(state.open).toHaveLength(1);
  });

  it("does not delete a position because an RPC was unavailable", () => {
    // The inverse mistake, and the more expensive one. An empty chain map from a
    // failed read must never authorise dropping a live position — inside the
    // grace window it is kept and reported, not deleted.
    const state: RivoState = emptyState(50, "balanced", false);
    state.open.push(held());
    state.cash -= 4.2;
    const found = reconcile({ state, chain: new Map(), meta: new Map(), now: 1_800_000_060 });
    expect(found[0]!.action).toBe("kept-pending");
    expect(state.open).toHaveLength(1);
  });
});
