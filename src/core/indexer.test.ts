import { describe, expect, it, afterEach, vi } from "vitest";
import { Indexer } from "./indexer.js";

/**
 * These tests never reach the network. They stand in for the indexer with a
 * fetch that answers from a fixed table of windows, because the thing worth
 * pinning down is not what the venue holds — it is which rows Rivo keeps when
 * it cannot keep all of them.
 */

/** One finalized window per hour, oldest first. */
function windows(count: number, firstExpiry = 1_700_000_000): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    marketId: `0x${String(i).padStart(4, "0")}`,
    asset: "BTC",
    intervalSec: 900,
    tradingStart: firstExpiry + i * 3600 - 900,
    expiry: firstExpiry + i * 3600,
    clobStatus: "Settled",
    strike: null,
    winningOutcome: 1,
    finalized: true,
    voided: false,
    tradeCount: 3,
    binaryPoolAddress: null,
  }));
}

/**
 * A fetch that honours `order_by`, `limit` and `offset` the way Hasura does.
 * Reading the direction out of the query text is the point: a test that ignored
 * it would pass against the ascending paging this exists to prevent.
 */
function stubIndexer(rows: Record<string, unknown>[]): void {
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as {
      query: string;
      variables: { limit: number; offset: number };
    };
    const ordered = /expiry:\s*desc/.test(query) ? [...rows].reverse() : rows;
    const page = ordered.slice(variables.offset, variables.offset + variables.limit);
    return {
      ok: true,
      json: async () => ({ data: { Market: page } }),
    } as unknown as Response;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("settledMarkets", () => {
  it("returns every window when the cap is not reached, oldest first", async () => {
    stubIndexer(windows(2500));
    const out = await new Indexer("testnet").settledMarkets({ limit: 60_000 });
    expect(out).toHaveLength(2500);
    expect(out[0]!.expiry).toBeLessThan(out[out.length - 1]!.expiry);
  });

  it("drops the OLDEST windows at the cap, never the newest", async () => {
    // The failure this pins: paging ascending, a cap reached mid-history
    // returns a sample that stops before the most recent settlements, and
    // nothing in the result says so. Calibration then stops advancing while
    // the venue keeps settling.
    const all = windows(4000);
    stubIndexer(all);
    const out = await new Indexer("testnet").settledMarkets({ limit: 1000 });

    expect(out).toHaveLength(1000);
    const newest = Number(all[all.length - 1]!.expiry);
    const keptNewest = out[out.length - 1]!.expiry;
    expect(keptNewest).toBe(newest);
    expect(out[0]!.expiry).toBeGreaterThan(Number(all[0]!.expiry));
  });

  it("still hands rows back in time order after truncating", async () => {
    stubIndexer(windows(4000));
    const out = await new Indexer("testnet").settledMarkets({ limit: 2500 });
    const expiries = out.map((m) => m.expiry);
    expect(expiries).toEqual([...expiries].sort((a, b) => a - b));
  });
});
