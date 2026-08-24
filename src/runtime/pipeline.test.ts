// Shadow and testnet reach the same verdict, or shadow is not evidence.
//
// The claim this product makes about shadow is that an agent which does well
// there has been tested against the constraints it will actually meet. That
// claim was false: shadow asked an agent and wrote the answer down, while the
// real path ran market eligibility, a risk ceiling, a strategy gate and the
// venue's lot rule. An agent could therefore look good in shadow at precisely
// the sizes real Rivo would have refused — the failure mode is not "shadow is
// approximate", it is "shadow is optimistic exactly where the limits bind".
//
// So both call preExecution, and these assert the two cannot drift apart.

import { describe, expect, it } from "vitest";
import { preExecution, normalizeToLot, LOT_STEPS_PER_SHARE, type PreExecutionInput } from "./pipeline.js";

const NOW = 1_800_000_000;

const input = (over: Partial<PreExecutionInput> = {}): PreExecutionInput => ({
  decision: { action: "BUY", notional: 8, price: 0.5 },
  market: { expiry: NOW + 600, now: NOW, ask: 0.5 },
  policy: {
    mode: "experimental_testnet",
    strategyState: "REJECTED",
    minTrade: 0.25,
    maxNotional: 10,
    experimentApproved: true,
  },
  ...over,
});

describe("shadow and testnet agree", () => {
  it("reaches the identical intent in both modes, differing only in maySign", () => {
    // The whole architecture in one assertion. If these ever diverge in shares,
    // cost, price, stage or reason, shadow has stopped being a rehearsal.
    const cases: Partial<PreExecutionInput>[] = [
      {},
      { decision: { action: "BUY", notional: 0.9, price: 0.31 } },
      { decision: { action: "BUY", notional: 8, price: 0.97 } },
      { decision: { action: "BUY", notional: 100, price: 0.5 } },
      { decision: { action: "SKIP", notional: null, price: null } },
      { market: { expiry: NOW - 1, now: NOW, ask: 0.5 } },
      { market: { expiry: NOW + 600, now: NOW, ask: null }, decision: { action: "BUY", notional: 8, price: null } },
    ];
    for (const over of cases) {
      const shadow = preExecution(input({ ...over, policy: { ...input().policy, mode: "shadow" } }));
      const testnet = preExecution(input({ ...over, policy: { ...input().policy, mode: "experimental_testnet" } }));
      const { maySign: _s, ...shadowRest } = shadow;
      const { maySign: _t, ...testnetRest } = testnet;
      expect(shadowRest, JSON.stringify(over)).toEqual(testnetRest);
    }
  });

  it("lets only the executing mode sign", () => {
    expect(preExecution(input({ policy: { ...input().policy, mode: "shadow" } })).maySign).toBe(false);
    expect(preExecution(input()).maySign).toBe(true);
  });

  it("never lets shadow produce a trade the real path would have refused", () => {
    // The specific inversion. A stake below the venue's lot is refused in BOTH,
    // so no hypothetical position exists for it — before this, shadow recorded
    // one and the agent's record improved for a trade that could not be placed.
    const tiny = input({ decision: { action: "BUY", notional: 0.001, price: 0.5 } });
    for (const mode of ["shadow", "experimental_testnet"] as const) {
      const i = preExecution({ ...tiny, policy: { ...tiny.policy, mode } });
      expect(i.outcome).toBe("REFUSED");
      expect(i.shares).toBe(0);
    }
  });
});

describe("deterministic size refusals are not execution failures", () => {
  it("refuses a stake below the minimum trade, naming it", () => {
    const i = preExecution(input({ decision: { action: "BUY", notional: 0.1, price: 0.5 } }));
    expect(i.outcome).toBe("REFUSED");
    expect(i.code).toBe("BELOW_VENUE_MINIMUM");
    expect(i.stage).toBe("RISK");
  });

  it("refuses a size that rounds to zero at the venue's lot", () => {
    // 0.30 collateral at 0.97 buys 0.309… shares, which floors to 0.30 — fine.
    // At a lot of one whole share it would floor to zero, and the point of the
    // code is that the reason is legible either way.
    const i = preExecution(
      input({
        decision: { action: "BUY", notional: 0.3, price: 0.99 },
        policy: { ...input().policy, minTrade: 0.01 },
      }),
    );
    // With the shipped lot this passes; the refusal path is exercised by forcing
    // a size under one step.
    expect(["EXECUTE", "REFUSED"]).toContain(i.outcome);

    const belowOneStep = 1 / LOT_STEPS_PER_SHARE / 2;
    const j = preExecution(
      input({
        decision: { action: "BUY", notional: belowOneStep * 0.5, price: 0.5 },
        policy: { ...input().policy, minTrade: 0 },
      }),
    );
    expect(j.outcome).toBe("REFUSED");
    expect(j.code).toBe("NORMALIZED_SIZE_ZERO");
    expect(j.stage).toBe("VENUE");
  });

  it("distinguishes declining from refusing", () => {
    // An agent that says nothing has not failed and must not be counted as a
    // refusal — the evidence table groups by this.
    expect(preExecution(input({ decision: { action: "SKIP", notional: null, price: null } })).outcome).toBe("SKIP");
    expect(preExecution(input({ decision: { action: "BUY", notional: 0.1, price: 0.5 } })).outcome).toBe("REFUSED");
  });

  it("rounds down, never up", () => {
    // Rounding up would place an order larger than the allocator authorised.
    for (const s of [9.749193184999303, 3.719999, 0.019, 1.0000001]) {
      expect(normalizeToLot(s)).toBeLessThanOrEqual(s);
      expect(normalizeToLot(s) * LOT_STEPS_PER_SHARE).toBeCloseTo(Math.round(normalizeToLot(s) * LOT_STEPS_PER_SHARE), 6);
    }
    expect(normalizeToLot(-1)).toBe(0);
    expect(normalizeToLot(Number.NaN)).toBe(0);
    expect(normalizeToLot(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("the pipeline fails closed", () => {
  it("blocks an unvalidated strategy from an executing mode", () => {
    const i = preExecution(
      input({
        policy: { ...input().policy, strategyState: "UNVALIDATED", experimentApproved: false },
      }),
    );
    expect(i.outcome).toBe("REFUSED");
    expect(i.code).toBe("STRATEGY_STATE_BLOCKED");
  });

  it("lets an approved experiment run a REJECTED strategy", () => {
    // The documented exception, and the mode Rivo actually ships under.
    expect(preExecution(input()).outcome).toBe("EXECUTE");
  });

  it("refuses an action it does not recognise", () => {
    const i = preExecution(input({ decision: { action: "YOLO", notional: 8, price: 0.5 } }));
    expect(i.outcome).toBe("REFUSED");
    expect(i.code).toBe("MALFORMED_DECISION");
  });

  it("refuses a non-finite notional rather than sizing from it", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const i = preExecution(input({ decision: { action: "BUY", notional: bad, price: 0.5 } }));
      expect(i.outcome, String(bad)).toBe("REFUSED");
      expect(i.code).toBe("MALFORMED_DECISION");
    }
  });

  it("skips an expired contract before consulting policy", () => {
    // Ordering matters for evidence: an expired market must read as expired, not
    // as a gate refusal, or the counts blame the wrong stage.
    const i = preExecution(
      input({
        market: { expiry: NOW, now: NOW, ask: 0.5 },
        policy: { ...input().policy, strategyState: "UNVALIDATED", experimentApproved: false },
      }),
    );
    expect(i.stage).toBe("ELIGIBILITY");
    expect(i.code).toBe("MARKET_EXPIRED");
  });

  it("skips a leg with no tradeable price", () => {
    for (const ask of [null, 0, 1, 1.5]) {
      const i = preExecution(input({ decision: { action: "BUY", notional: 8, price: null }, market: { expiry: NOW + 600, now: NOW, ask } }));
      expect(i.code, String(ask)).toBe("NO_TRADEABLE_PRICE");
    }
  });

  it("applies the tightest of every ceiling", () => {
    const i = preExecution(
      input({
        decision: { action: "BUY", notional: 100, price: 0.5 },
        policy: { ...input().policy, maxNotional: 6 },
        risk: { allowedCost: 3, binding: "BTC delta budget" },
      }),
    );
    expect(i.outcome).toBe("EXECUTE");
    expect(i.cost).toBeCloseTo(3, 6);
    expect(i.reason).toBe("BTC delta budget");
  });

  it("refuses when risk left no budget at all", () => {
    const i = preExecution(input({ risk: { allowedCost: 0, binding: "cash floor" } }));
    expect(i.outcome).toBe("REFUSED");
    expect(i.code).toBe("RISK_LIMIT");
    expect(i.reason).toBe("cash floor");
  });

  it("never throws, whatever it is handed", () => {
    // Total by construction: it runs on the path between an untrusted agent
    // response and a signer, and an exception there is an unhandled rejection
    // in a worker rather than a refusal.
    const junk = [
      { action: "", notional: null, price: null },
      { action: "BUY", notional: null, price: Number.NaN },
      { action: "buy", notional: 1e308, price: 1e-308 },
    ];
    for (const decision of junk) {
      expect(() => preExecution(input({ decision }))).not.toThrow();
    }
  });
});
