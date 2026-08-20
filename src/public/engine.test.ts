// The browser engine holds real capital accounting, so what is pinned here is
// the money: a settlement that pays out, one that does not, a voided window that
// must return the premium, and the refusal to resolve a window the venue has not
// finalized. Getting any of these wrong shows up as an equity curve that lies.

import { describe, expect, it } from "vitest";
import { emptyPortfolio, settleShadow, type ShadowPortfolio, type ShadowPosition } from "./engine.js";
import { newPolicy } from "../portfolio/policy.js";
import type { Indexer } from "../core/indexer.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const NOW = 1_800_000_000;

const position = (over: Partial<ShadowPosition> = {}): ShadowPosition => ({
  marketId: "0xmarket1",
  asset: "BTC",
  intervalSec: 3600,
  leg: "UP",
  shares: 10,
  entryPrice: 0.4,
  cost: 4,
  expiry: NOW - 60,
  deltaPer1PctPerShare: 0.02,
  openedAt: NOW - 3600,
  fairAtEntry: 0.5,
  ...over,
});

/** Only the one method settleShadow uses. */
const idxWith = (outcomes: Record<string, { finalized: boolean; voided: boolean; winningOutcome: number | null; expiry: number }>) =>
  ({
    outcomes: async () => new Map(Object.entries(outcomes)),
  }) as unknown as Indexer;

function portfolioWith(open: ShadowPosition[], cash = 46): ShadowPortfolio {
  const pf = emptyPortfolio(newPolicy(OWNER, 50, "balanced"));
  pf.open = open;
  pf.cash = cash;
  return pf;
}

describe("settleShadow", () => {
  it("pays one collateral per share on a win and books the profit", async () => {
    const pf = portfolioWith([position()]);
    await settleShadow(idxWith({ "0xmarket1": { finalized: true, voided: false, winningOutcome: 0, expiry: NOW - 60 } }), pf, NOW, () => {});
    expect(pf.open).toHaveLength(0);
    expect(pf.cash).toBe(56); // 46 + 10 shares paying 1
    expect(pf.realizedPnl).toBe(6); // 10 received against 4 paid
    expect(pf.closed[0]).toMatchObject({ won: 1, proceeds: 10, exit: "settled" });
  });

  it("pays nothing on a loss and books the premium as the loss", async () => {
    const pf = portfolioWith([position()]);
    // winningOutcome 1 is DOWN; the position is UP.
    await settleShadow(idxWith({ "0xmarket1": { finalized: true, voided: false, winningOutcome: 1, expiry: NOW - 60 } }), pf, NOW, () => {});
    expect(pf.cash).toBe(46);
    expect(pf.realizedPnl).toBe(-4);
    expect(pf.closed[0]).toMatchObject({ won: 0, proceeds: 0 });
  });

  it("returns the premium on a voided window, leaving P&L untouched", async () => {
    const pf = portfolioWith([position()]);
    await settleShadow(idxWith({ "0xmarket1": { finalized: false, voided: true, winningOutcome: null, expiry: NOW - 60 } }), pf, NOW, () => {});
    expect(pf.cash).toBe(50);
    expect(pf.realizedPnl).toBe(0);
    expect(pf.closed[0]!.exit).toBe("voided");
  });

  it("HOLDS a position the venue has not finalized rather than inventing a result", async () => {
    // Expiry passing and the oracle answering are minutes apart. Forcing a
    // result here would book a loss on a window that later paid out.
    const pf = portfolioWith([position()]);
    await settleShadow(idxWith({ "0xmarket1": { finalized: false, voided: false, winningOutcome: null, expiry: NOW - 60 } }), pf, NOW, () => {});
    expect(pf.open).toHaveLength(1);
    expect(pf.closed).toHaveLength(0);
  });

  it("holds a position whose outcome the indexer did not return at all", async () => {
    const pf = portfolioWith([position()]);
    await settleShadow(idxWith({}), pf, NOW, () => {});
    expect(pf.open).toHaveLength(1);
  });

  it("leaves unexpired positions alone and does not call the indexer for them", async () => {
    let called = false;
    const idx = {
      outcomes: async () => {
        called = true;
        return new Map();
      },
    } as unknown as Indexer;
    const pf = portfolioWith([position({ expiry: NOW + 600 })]);
    await settleShadow(idx, pf, NOW, () => {});
    expect(called).toBe(false);
    expect(pf.open).toHaveLength(1);
  });

  it("settles a DOWN leg against the DOWN outcome", async () => {
    const pf = portfolioWith([position({ leg: "DOWN", deltaPer1PctPerShare: -0.02 })]);
    await settleShadow(idxWith({ "0xmarket1": { finalized: true, voided: false, winningOutcome: 1, expiry: NOW - 60 } }), pf, NOW, () => {});
    expect(pf.closed[0]!.won).toBe(1);
    expect(pf.cash).toBe(56);
  });

  it("keeps cash and positions consistent across a mixed batch", async () => {
    const pf = portfolioWith([
      position({ marketId: "0xa" }),
      position({ marketId: "0xb", shares: 5, cost: 3 }),
      position({ marketId: "0xc", expiry: NOW + 900 }),
    ]);
    await settleShadow(
      idxWith({
        "0xa": { finalized: true, voided: false, winningOutcome: 0, expiry: NOW - 60 },
        "0xb": { finalized: true, voided: false, winningOutcome: 1, expiry: NOW - 60 },
      }),
      pf, NOW, () => {},
    );
    expect(pf.open.map((p) => p.marketId)).toEqual(["0xc"]);
    expect(pf.cash).toBe(56); // 46 + 10 from the winner, nothing from the loser
    expect(pf.realizedPnl).toBe(3); // +6 and −3
  });

  it("matches market ids case-insensitively", async () => {
    // The indexer lowercases ids; a position may carry the checksummed form.
    const pf = portfolioWith([position({ marketId: "0xMARKET1" })]);
    await settleShadow(idxWith({ "0xmarket1": { finalized: true, voided: false, winningOutcome: 0, expiry: NOW - 60 } }), pf, NOW, () => {});
    expect(pf.open).toHaveLength(0);
  });
});
