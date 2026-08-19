// Reconciliation rewrites the portfolio, so it has to be exactly right in both
// directions: too eager and it deletes a position that merely has not reached
// the indexer yet; too timid and the bug it exists to prevent survives.

import { describe, expect, it } from "vitest";
import { INDEXER_LAG_GRACE_SEC, reconcile } from "./reconcile.js";
import { emptyState, type HeldPosition, type RivoState } from "./state.js";

const NOW = 1_800_000_000;
const MKT = "0xabc";

function pos(over: Partial<HeldPosition> = {}): HeldPosition {
  return {
    marketId: MKT,
    asset: "BTC",
    intervalSec: 3600,
    leg: "UP",
    shares: 10,
    entryPrice: 0.5,
    cost: 5,
    expiry: NOW + 1800,
    deltaPer1PctPerShare: 0.01,
    openedAt: NOW - 600, // old enough to be past the grace window
    fairAtEntry: 0.6,
    ...over,
  };
}

const stateWith = (open: HeldPosition[]): RivoState => ({ ...emptyState(100, "balanced", true), open });
const chainOf = (pairs: [string, number][]) => new Map(pairs);
const metaOf = (k: string) =>
  new Map([[k, { asset: "BTC" as const, intervalSec: 3600, expiry: NOW + 1800, fair: 0.55 }]]);

describe("reconcile — agreement", () => {
  it("reports nothing when state and chain agree", () => {
    const s = stateWith([pos()]);
    const d = reconcile({ state: s, chain: chainOf([[`${MKT}:UP`, 10]]), now: NOW });
    expect(d).toHaveLength(0);
    expect(s.open).toHaveLength(1);
  });

  it("ignores a floating-point rounding difference", () => {
    const s = stateWith([pos({ shares: 10 })]);
    const d = reconcile({ state: s, chain: chainOf([[`${MKT}:UP`, 10 + 1e-12]]), now: NOW });
    expect(d).toHaveLength(0);
  });
});

describe("reconcile — the chain holds less than state claims", () => {
  it("drops a position the chain does not have", () => {
    const s = stateWith([pos()]);
    const d = reconcile({ state: s, chain: chainOf([]), now: NOW });
    expect(s.open).toHaveLength(0);
    expect(d[0]!.action).toBe("dropped");
  });

  it("scales a partially-filled position down to what the chain shows", () => {
    const s = stateWith([pos({ shares: 10, cost: 5 })]);
    reconcile({ state: s, chain: chainOf([[`${MKT}:UP`, 4]]), now: NOW });
    expect(s.open[0]!.shares).toBe(4);
    // Cost basis moves with it, so the average entry price is unchanged.
    expect(s.open[0]!.cost).toBeCloseTo(2, 10);
    expect(s.open[0]!.cost / s.open[0]!.shares).toBeCloseTo(0.5, 10);
  });

  it("scales every lot of a leg by the same factor", () => {
    const s = stateWith([pos({ shares: 10, cost: 5 }), pos({ shares: 30, cost: 21 })]);
    reconcile({ state: s, chain: chainOf([[`${MKT}:UP`, 20]]), now: NOW }); // half of 40
    expect(s.open.map((p) => p.shares)).toEqual([5, 15]);
    expect(s.open.map((p) => p.cost)).toEqual([2.5, 10.5]);
  });

  it("does NOT drop a position opened moments ago", () => {
    // The indexer lags the chain by seconds. Deleting a just-filled position for
    // being invisible is the more expensive of the two possible mistakes.
    const s = stateWith([pos({ openedAt: NOW - 5 })]);
    const d = reconcile({ state: s, chain: chainOf([]), now: NOW });
    expect(s.open).toHaveLength(1);
    expect(d[0]!.action).toBe("kept-pending");
    expect(d[0]!.detail).toMatch(/grace window/);
  });

  it("drops it once the grace window has passed", () => {
    const s = stateWith([pos({ openedAt: NOW - INDEXER_LAG_GRACE_SEC - 1 })]);
    reconcile({ state: s, chain: chainOf([]), now: NOW });
    expect(s.open).toHaveLength(0);
  });

  it("still trusts the chain immediately when it holds MORE than state", () => {
    // Only a shortfall is ambiguous. Extra shares cannot be indexer lag.
    const s = stateWith([pos({ shares: 10, cost: 5, openedAt: NOW - 1 })]);
    reconcile({ state: s, chain: chainOf([[`${MKT}:UP`, 25]]), now: NOW });
    expect(s.open[0]!.shares).toBe(25);
  });
});

describe("reconcile — the chain holds what state never recorded", () => {
  it("adopts a live position and flags the estimated cost basis", () => {
    // This is the bug the module exists for: a fill landed, the process died
    // before state was written, and without adoption Rivo buys a second copy.
    const s = stateWith([]);
    const d = reconcile({
      state: s,
      chain: chainOf([[`${MKT}:UP`, 7]]),
      meta: metaOf(`${MKT}:UP`),
      marks: new Map([[`${MKT}:UP`, 0.42]]),
      now: NOW,
    });
    expect(s.open).toHaveLength(1);
    expect(s.open[0]!.shares).toBe(7);
    expect(s.open[0]!.entryPrice).toBe(0.42);
    expect(s.open[0]!.cost).toBeCloseTo(7 * 0.42, 10);
    expect(s.open[0]!.adopted).toBe(true);
    expect(d[0]!.action).toBe("adopted");
    expect(d[0]!.detail).toMatch(/ESTIMATED/);
  });

  it("falls back to an even-money mark when none is supplied", () => {
    const s = stateWith([]);
    reconcile({ state: s, chain: chainOf([[`${MKT}:DOWN`, 4]]), meta: metaOf(`${MKT}:DOWN`), now: NOW });
    expect(s.open[0]!.entryPrice).toBe(0.5);
    expect(s.open[0]!.leg).toBe("DOWN");
  });

  it("refuses to adopt a holding whose window is not live", () => {
    // Usually an unclaimed payout or an off-venue market. A position with no
    // expiry cannot be managed or settled, so inventing one would be worse than
    // reporting it.
    const s = stateWith([]);
    const d = reconcile({ state: s, chain: chainOf([["0xdead:UP", 100]]), now: NOW });
    expect(s.open).toHaveLength(0);
    expect(d[0]!.action).toBe("kept-pending");
    expect(d[0]!.detail).toMatch(/unclaimed or off-venue/);
  });
});

describe("reconcile — legs are tracked separately", () => {
  it("does not confuse the two legs of one market", () => {
    const s = stateWith([pos({ leg: "UP", shares: 10 }), pos({ leg: "DOWN", shares: 3 })]);
    reconcile({
      state: s,
      chain: chainOf([
        [`${MKT}:UP`, 10],
        [`${MKT}:DOWN`, 8],
      ]),
      now: NOW,
    });
    expect(s.open.find((p) => p.leg === "UP")!.shares).toBe(10);
    expect(s.open.find((p) => p.leg === "DOWN")!.shares).toBe(8);
  });

  it("matches keys case-insensitively, since addresses arrive both ways", () => {
    const s = stateWith([pos({ marketId: "0xABC" })]);
    const d = reconcile({ state: s, chain: chainOf([["0xabc:UP", 10]]), now: NOW });
    expect(d).toHaveLength(0);
  });
});
