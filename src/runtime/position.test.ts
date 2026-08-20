// The position manager decides when acting is worth the spread it costs. Its one
// production bug was a stop that re-fired on the same information every cycle,
// halving a position four times over four minutes. That is pinned below.

import { describe, expect, it } from "vitest";
import { legKey, manage, rotationPays, type ManageInputs } from "./position.js";
import { PROFILES } from "../portfolio/profiles.js";
import { buildBook, type MarketBook } from "../engine/book.js";
import type { Opportunity } from "../engine/opportunity.js";
import type { HeldPosition } from "./state.js";

const NOW = 1_800_000_000;

function pos(over: Partial<HeldPosition> = {}): HeldPosition {
  return {
    marketId: "0xm",
    asset: "BTC",
    intervalSec: 3600,
    leg: "UP",
    shares: 10,
    entryPrice: 0.5,
    cost: 5,
    // Well clear of the expiry headroom (40% of 3600s = 1440s).
    expiry: NOW + 3000,
    deltaPer1PctPerShare: 0.01,
    openedAt: NOW - 600,
    fairAtEntry: 0.6,
    ...over,
  };
}

function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    marketId: "0xm",
    asset: "BTC",
    intervalSec: 3600,
    expiry: NOW + 3000,
    leg: "UP",
    fair: 0.6,
    ask: 0.55,
    bid: over.bid ?? null,
    mid: 0.52,
    edge: 0.05,
    depthAtFair: 100,
    tauMinutes: 50,
    phase: 0.2,
    moneyness: 0.001,
    sigmaRemaining: 0.01,
    z: 0.1,
    deltaPerShare: 1e-6,
    blocked: null,
    ...over,
  };
}

/** A two-sided book on the UP leg: bid from BUY_YES, ask from SELL_YES. */
function book(bid: number, ask: number): MarketBook {
  return buildBook([
    { side: "BUY_YES", price: bid, size: 1000 },
    { side: "SELL_YES", price: ask, size: 1000 },
  ]);
}

function inputs(over: Partial<ManageInputs> = {}): ManageInputs {
  const positions = over.positions ?? [pos()];
  return {
    positions,
    opportunities: over.opportunities ?? new Map(positions.map((p) => [legKey(p.marketId, p.leg), opp({ leg: p.leg })])),
    books: over.books ?? new Map(positions.map((p) => [p.marketId, book(0.5, 0.55)])),
    profile: PROFILES.balanced,
    now: NOW,
    lastTradedAt: {},
    cooldownSec: 180,
    ...over,
  };
}

describe("manage — cooldown (regression)", () => {
  // The bug: the conviction stop measured against fairAtEntry, which never moved,
  // so one 0.078 drop halved the same position every cycle — 3.06 -> 1.53 -> 0.76
  // -> 0.38 — paying a spread each time. The cooldown is the guard.
  it("holds a leg that was acted on inside the cooldown", () => {
    const p = pos({ fairAtEntry: 0.9 }); // a big drop, so the stop would fire
    const r = manage(
      inputs({
        positions: [p],
        opportunities: new Map([[legKey(p.marketId, p.leg), opp({ fair: 0.5 })]]),
        lastTradedAt: { [legKey(p.marketId, p.leg)]: NOW - 30 },
      }),
    );
    expect(r[0]!.action).toBe("HOLD");
    expect(r[0]!.reason).toMatch(/cooling down/);
  });

  it("acts once the cooldown has elapsed", () => {
    const p = pos({ fairAtEntry: 0.9 });
    const r = manage(
      inputs({
        positions: [p],
        opportunities: new Map([[legKey(p.marketId, p.leg), opp({ fair: 0.5 })]]),
        lastTradedAt: { [legKey(p.marketId, p.leg)]: NOW - 600 },
      }),
    );
    expect(r[0]!.action).not.toBe("HOLD");
  });
});

describe("manage — RECOVER", () => {
  it("merges offsetting legs rather than leaving collateral locked to expiry", () => {
    const up = pos({ leg: "UP", shares: 10 });
    const down = pos({ leg: "DOWN", shares: 6 });
    const r = manage(inputs({ positions: [up, down] }));
    expect(r.every((d) => d.action === "RECOVER")).toBe(true);
    // Six pairs offset; each leg contributes at most what it holds.
    expect(r.find((d) => d.position.leg === "UP")!.size).toBe(6);
    expect(r.find((d) => d.position.leg === "DOWN")!.size).toBe(6);
  });

  it("leaves a purely directional position alone", () => {
    const r = manage(inputs({ positions: [pos({ leg: "UP", shares: 10 })] }));
    expect(r[0]!.action).not.toBe("RECOVER");
  });
});

describe("manage — the spread is the cost of acting", () => {
  it("exits when the bid beats holding by more than the round trip", () => {
    // Model says the leg is worth 0.50; the book bids 0.60. Selling is free money.
    const r = manage(
      inputs({
        opportunities: new Map([[legKey("0xm", "UP"), opp({ fair: 0.5 })]]),
        books: new Map([["0xm", book(0.6, 0.65)]]),
      }),
    );
    expect(r[0]!.action).toBe("EXIT");
    expect(r[0]!.size).toBe(10);
  });

  it("holds when selling would give up model value", () => {
    // Bid 0.40 against a model value of 0.50: exiting realises the spread for
    // nothing. fairAtEntry is set near the current model value so the conviction
    // stop stays out of it — this test is about the exit arithmetic alone.
    const r = manage(
      inputs({
        positions: [pos({ fairAtEntry: 0.52 })],
        opportunities: new Map([[legKey("0xm", "UP"), opp({ fair: 0.5 })]]),
        books: new Map([["0xm", book(0.4, 0.45)]]),
      }),
    );
    expect(r[0]!.action).toBe("HOLD");
  });

  it("cannot exit into an empty bid, and says so", () => {
    const oneSided = buildBook([{ side: "SELL_YES", price: 0.55, size: 100 }]);
    const r = manage(inputs({ books: new Map([["0xm", oneSided]]) }));
    expect(r[0]!.action).toBe("HOLD");
    expect(r[0]!.reason).toMatch(/no bid/);
  });

  it("halves rather than exits when conviction falls but the bid under-pays", () => {
    const p = pos({ fairAtEntry: 0.9, shares: 10 });
    const r = manage(
      inputs({
        positions: [p],
        opportunities: new Map([[legKey("0xm", "UP"), opp({ fair: 0.5 })]]),
        books: new Map([["0xm", book(0.45, 0.5)]]),
      }),
    );
    expect(r[0]!.action).toBe("REDUCE");
    expect(r[0]!.size).toBe(5);
  });
});

describe("manage — expiry", () => {
  it("holds to settlement inside the expiry headroom", () => {
    // Headroom is 40% of the series interval but CAPPED AT 300s, so a 1h window
    // stops acting five minutes out, not twenty-four. Worth stating: the fixture
    // that assumed 1440s passed this test for the wrong reason.
    const p = pos({ expiry: NOW + 200 });
    const r = manage(
      inputs({
        positions: [p],
        opportunities: new Map([[legKey("0xm", "UP"), opp({ fair: 0.1, expiry: NOW + 200 })]]),
        books: new Map([["0xm", book(0.6, 0.65)]]),
      }),
    );
    expect(r[0]!.action).toBe("HOLD");
    expect(r[0]!.reason).toMatch(/expiry headroom/);
  });

  it("holds a position whose window has left the live list", () => {
    const r = manage(inputs({ opportunities: new Map() }));
    expect(r[0]!.action).toBe("HOLD");
    expect(r[0]!.reason).toMatch(/awaiting settlement/);
  });
});

describe("rotationPays", () => {
  it("refuses a swap that does not clear the round trip", () => {
    // Give up 0.05 of model value on the way out to gain 0.04 on the way in.
    const r = rotationPays({ fairNow: 0.6, bidNow: 0.55 }, { fair: 0.64, ask: 0.6 }, PROFILES.balanced);
    expect(r.pays).toBe(false);
  });

  it("allows a swap that clearly beats the cost of making it", () => {
    const r = rotationPays({ fairNow: 0.6, bidNow: 0.595 }, { fair: 0.8, ask: 0.5 }, PROFILES.balanced);
    expect(r.pays).toBe(true);
  });
});
