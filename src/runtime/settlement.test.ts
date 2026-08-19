// Settlement is the only place an outcome moves collateral. Everything else is
// bookkeeping around it, so an error here is silently wrong in the direction of
// believing you have money you do not.

import { describe, expect, it } from "vitest";
import { resolveSettled } from "./loop.js";
import { emptyState, type HeldPosition, type RivoState } from "./state.js";

const NOW = 1_800_000_000;

function pos(over: Partial<HeldPosition> = {}): HeldPosition {
  return {
    marketId: "0xa",
    asset: "BTC",
    intervalSec: 3600,
    leg: "UP",
    shares: 10,
    entryPrice: 0.5,
    cost: 5,
    expiry: NOW - 60, // already ended
    deltaPer1PctPerShare: 0.01,
    openedAt: NOW - 3600,
    fairAtEntry: 0.6,
    ...over,
  };
}

type Outcome = { finalized: boolean; voided: boolean; winningOutcome: number | null; expiry: number };

/** Just enough Indexer for settlement: it only ever calls `outcomes`. */
function idxWith(map: Record<string, Outcome>) {
  return {
    outcomes: async (ids: string[]) => {
      const out = new Map<string, Outcome>();
      for (const id of ids) {
        const o = map[id.toLowerCase()];
        if (o) out.set(id.toLowerCase(), o);
      }
      return out;
    },
  } as unknown as Parameters<typeof resolveSettled>[1];
}

const stateWith = (open: HeldPosition[], cash = 100): RivoState => ({
  ...emptyState(100, "balanced", true),
  cash,
  open,
});

const won: Outcome = { finalized: true, voided: false, winningOutcome: 0, expiry: NOW - 60 };
const lost: Outcome = { finalized: true, voided: false, winningOutcome: 1, expiry: NOW - 60 };
const voided: Outcome = { finalized: false, voided: true, winningOutcome: null, expiry: NOW - 60 };

describe("resolveSettled", () => {
  it("pays a winning leg one collateral per share", async () => {
    const s = stateWith([pos({ leg: "UP" })]);
    const n = await resolveSettled(s, idxWith({ "0xa": won }), NOW, () => {});
    expect(n).toBe(1);
    expect(s.cash).toBe(110); // 100 + 10 shares
    expect(s.realizedPnl).toBe(5); // 10 back on a cost of 5
    expect(s.open).toHaveLength(0);
    expect(s.closed[0]!.won).toBe(1);
    expect(s.closed[0]!.exit).toBe("settled");
  });

  it("pays a losing leg nothing", async () => {
    const s = stateWith([pos({ leg: "UP" })]);
    await resolveSettled(s, idxWith({ "0xa": lost }), NOW, () => {});
    expect(s.cash).toBe(100);
    expect(s.realizedPnl).toBe(-5);
    expect(s.closed[0]!.won).toBe(0);
  });

  it("reads the DOWN leg as the mirror of the outcome", async () => {
    // winningOutcome 0 means UP won, so a DOWN holder loses.
    const s = stateWith([pos({ leg: "DOWN" })]);
    await resolveSettled(s, idxWith({ "0xa": won }), NOW, () => {});
    expect(s.closed[0]!.won).toBe(0);

    const s2 = stateWith([pos({ leg: "DOWN" })]);
    await resolveSettled(s2, idxWith({ "0xa": lost }), NOW, () => {});
    expect(s2.closed[0]!.won).toBe(1);
    expect(s2.cash).toBe(110);
  });

  it("redeems both legs of a voided window at 0.5, scored as neither win nor loss", async () => {
    // The protocol's answer when no reliable settlement price exists. Counting it
    // as a loss would slander the model; counting it as a win would flatter it.
    const s = stateWith([pos({ leg: "UP" }), pos({ marketId: "0xb", leg: "DOWN" })]);
    await resolveSettled(s, idxWith({ "0xa": voided, "0xb": voided }), NOW, () => {});
    expect(s.cash).toBe(110); // 5 + 5 back on 10 total cost
    expect(s.realizedPnl).toBe(0);
    expect(s.closed.every((c) => c.exit === "voided")).toBe(true);
    expect(s.closed.every((c) => c.won === 0)).toBe(true); // not counted as wins
  });

  it("leaves positions whose windows have not ended", async () => {
    const s = stateWith([pos({ expiry: NOW + 600 })]);
    const n = await resolveSettled(s, idxWith({ "0xa": won }), NOW, () => {});
    expect(n).toBe(0);
    expect(s.open).toHaveLength(1);
    expect(s.cash).toBe(100);
  });

  it("leaves positions whose windows ended but have not settled yet", async () => {
    // Expiry has passed but the oracle has not answered. Paying out here would
    // invent collateral that does not exist.
    const pending: Outcome = { finalized: false, voided: false, winningOutcome: null, expiry: NOW - 60 };
    const s = stateWith([pos()]);
    const n = await resolveSettled(s, idxWith({ "0xa": pending }), NOW, () => {});
    expect(n).toBe(0);
    expect(s.open).toHaveLength(1);
  });

  it("leaves a position the indexer has no row for at all", async () => {
    const s = stateWith([pos()]);
    const n = await resolveSettled(s, idxWith({}), NOW, () => {});
    expect(n).toBe(0);
    expect(s.open).toHaveLength(1);
  });

  it("reconciles cash and P&L across a mixed batch", async () => {
    const s = stateWith([
      pos({ marketId: "0xa", leg: "UP" }), // wins  -> +10, pnl +5
      pos({ marketId: "0xb", leg: "UP" }), // loses ->   0, pnl -5
      pos({ marketId: "0xc", leg: "DOWN" }), // wins -> +10, pnl +5
      pos({ marketId: "0xd", expiry: NOW + 600 }), // still open
    ]);
    await resolveSettled(
      s,
      idxWith({ "0xa": won, "0xb": lost, "0xc": lost, "0xd": won }),
      NOW,
      () => {},
    );
    expect(s.open).toHaveLength(1);
    expect(s.closed).toHaveLength(3);
    expect(s.cash).toBe(120); // 100 + 10 + 0 + 10
    expect(s.realizedPnl).toBe(5); // +5 -5 +5
    // Cash equals opening cash plus every proceed; nothing invented, nothing lost.
    const proceeds = s.closed.reduce((n, c) => n + c.proceeds, 0);
    expect(s.cash).toBe(100 + proceeds);
  });
});
