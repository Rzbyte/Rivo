// The fourth instance of the shape `permission.ts` opens with, and the test
// that would have caught it.
//
// `executor-gate.test.ts` proves the verdict is wired into the object that
// spends. `pipeline.test.ts` proves shadow and execution reach identical intents
// apart from `maySign`. Both passed throughout, because neither asked the
// question this file asks: does anything READ `maySign`, and does the process
// that owns a private key ever say which mode it is in?
//
// It did not, and it did not. `src/cli/run.ts` called `cycle()` without a
// `mode`; `loop.ts` defaults that to "shadow"; `preExecution`'s POLICY stage
// only asks about the strategy's standing when `modeIntendsExecution(mode)` is
// true. So `npm start -- --live` placed real orders for a strategy this
// repository's own evidence calls REJECTED, and — with no network guard on that
// path either — would have done the same on mainnet.

import { describe, expect, it } from "vitest";
import { assertMaySign } from "./loop.js";
import { preExecution } from "./pipeline.js";
import { EXPERIMENTAL_NETWORKS, modeIntendsExecution, type ExecutionMode } from "./permission.js";
import { PRODUCTION_STRATEGY } from "../research/gating.js";

/** One order, priced so that nothing but the policy stage can refuse it. */
const intentFor = (mode: ExecutionMode) =>
  preExecution({
    decision: { action: "BUY", notional: 5, price: 0.4 },
    market: { expiry: 2_000_000_000, now: 1_000_000_000, ask: 0.4 },
    policy: {
      mode,
      strategyState: PRODUCTION_STRATEGY.state,
      minTrade: 0.25,
      maxNotional: 5,
      experimentApproved: mode === "experimental_testnet",
    },
    risk: { allowedCost: 5, binding: "none" },
  });

describe("maySign is load-bearing", () => {
  it("refuses a live executor on a path that may not sign", () => {
    expect(() => assertMaySign("live", false, "shadow", "BTC UP 0xabc")).toThrow(/refusing to sign/);
  });

  it("names the mode and the market, so the log says which wiring broke", () => {
    expect(() => assertMaySign("live", false, "shadow", "BTC UP 0xabc")).toThrow(/"shadow".*BTC UP 0xabc/s);
  });

  it("permits a live executor once the path may sign", () => {
    expect(() => assertMaySign("live", true, "experimental_testnet", "BTC UP 0xabc")).not.toThrow();
  });

  it("leaves dry runs alone — simulating a fill is their whole job", () => {
    expect(() => assertMaySign("dry", false, "shadow", "BTC UP 0xabc")).not.toThrow();
  });
});

describe("the shadow default is not a licence to spend", () => {
  it("still reaches EXECUTE in shadow — the intent is computed, not suppressed", () => {
    // This is why the bug survived: shadow does not refuse the order, it refuses
    // to SIGN it. A test asserting `outcome === "SKIP"` would have been wrong.
    expect(intentFor("shadow").outcome).toBe("EXECUTE");
  });

  it("but marks it unsignable, which is the field that now stops it", () => {
    expect(intentFor("shadow").maySign).toBe(false);
  });

  it("so a live executor reached from the CLI's old default would throw", () => {
    const intent = intentFor("shadow");
    expect(() => assertMaySign("live", intent.maySign, "shadow", "BTC UP 0xabc")).toThrow();
  });

  it("and the declared experimental mode is signable, as the product describes", () => {
    const intent = intentFor("experimental_testnet");
    expect(intent.outcome).toBe("EXECUTE");
    expect(intent.maySign).toBe(true);
    expect(() => assertMaySign("live", intent.maySign, "experimental_testnet", "BTC UP 0xabc")).not.toThrow();
  });
});

describe("the network bound the CLI now enforces", () => {
  it("approves testnet for experimental execution", () => {
    expect(EXPERIMENTAL_NETWORKS).toContain("testnet");
  });

  // The guard in `src/cli/run.ts` is `!EXPERIMENTAL_NETWORKS.includes(net)`, so
  // this constant is the whole reason `NETWORK=mainnet npm start -- --live`
  // refuses. If mainnet is ever added here, that refusal disappears silently.
  it("never approves mainnet, which is what makes the CLI refuse to run there", () => {
    expect(EXPERIMENTAL_NETWORKS).not.toContain("mainnet");
  });

  it("the shipping strategy is the one this bound exists for", () => {
    expect(PRODUCTION_STRATEGY.state).not.toBe("VALIDATED");
    expect(modeIntendsExecution("experimental_testnet")).toBe(true);
    expect(modeIntendsExecution("shadow")).toBe(false);
  });
});
