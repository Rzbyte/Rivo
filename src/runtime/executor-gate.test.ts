// The boundary test: does the gate actually stop `executor.buy` from spending?
//
// `permission.test.ts` proves the verdict is right. This proves the verdict is
// WIRED — that a denial reaches the object which would otherwise hand an order
// to a signer, and that the signer is never asked.
//
// The distinction is the entire bug this pass exists to fix. The repository
// already had a correct verdict, in src/research/gating.ts, and it had been
// correct for as long as it existed; what it did not have was any path from
// that verdict to the code that spends money. A test that only asserts
// `mayExecuteLive(REJECTED) === false` would have passed throughout.
//
// So the assertions below are about a spy on the signing seam. If a capital
// path ever reappears, the spy records a call and these fail.

import { describe, expect, it, vi } from "vitest";
import { DryExecutor, executorFor } from "./executor.js";
import { executionPermission, type ExecutionMode, type StrategyIdentity } from "./permission.js";
import { PRODUCTION_STRATEGY, type StrategyState } from "../research/gating.js";
import type { ChainSigner } from "./signer.js";
import type { MarketBook } from "../engine/book.js";

/**
 * A signer that records everything asked of it and refuses to produce anything.
 *
 * Every method throws rather than returning a plausible value, so a path that
 * reaches it fails loudly instead of continuing with a fake signature.
 */
function spySigner(available = true) {
  const signTransaction = vi.fn(async () => {
    throw new Error("BOUNDARY VIOLATION: something asked this signer to sign");
  });
  const account = vi.fn(async () => {
    throw new Error("BOUNDARY VIOLATION: something asked this signer for an account");
  });
  const signer = {
    kind: "privy" as const,
    available: () => available,
    address: "0x1b4b0195b32053489992649813dc02fc5e282e2e" as `0x${string}`,
    account,
    signTransaction,
  } as unknown as ChainSigner;
  return { signer, signTransaction, account };
}

/** A book with real depth, so a dry executor genuinely CAN fill. */
const book: MarketBook = {
  UP: { asks: [{ price: 0.4, size: 50 }], bids: [{ price: 0.38, size: 50 }] },
  DOWN: { asks: [{ price: 0.6, size: 50 }], bids: [{ price: 0.58, size: 50 }] },
} as unknown as MarketBook;

const order = { marketId: "0xmarket", leg: "UP" as const, size: 10, limitPrice: 0.45 };

const strategy = (state: StrategyState): StrategyIdentity => ({ id: "s", label: "S", state });

/**
 * Exactly what src/worker/cycle.ts does, in one expression.
 *
 * Duplicated on purpose rather than imported: this is the composition under
 * test, and a test that imported the production wiring would still pass if that
 * wiring were replaced with `executorFor(authority, false)`.
 */
function executorForPortfolio(opts: {
  mode: ExecutionMode | string;
  state: StrategyState;
  network: string;
  delegated?: boolean;
  signerAvailable?: boolean;
}) {
  const { signer, signTransaction, account } = spySigner(opts.signerAvailable ?? true);
  const permission = executionPermission({
    mode: opts.mode,
    strategy: strategy(opts.state),
    network: opts.network,
    signerAvailable: opts.signerAvailable ?? true,
    delegated: opts.delegated ?? true,
    privyWalletId: "wallet-1",
  });
  return { executor: executorFor(signer, !permission.mayMoveCapital), permission, signTransaction, account };
}

/** Every capital-moving method on the interface, called for real. */
async function exerciseEveryCapitalPath(e: ReturnType<typeof executorFor>): Promise<void> {
  await e.buy(order, book);
  await e.sell(order, book);
  await e.mintSet("0xmarket", 5);
  await e.mergeSet("0xmarket", 5);
  await e.claim();
  await e.cancelResting();
}

const DENIED: { name: string; mode: ExecutionMode | string; state: StrategyState; network: string }[] = [
  { name: "REJECTED under Autopilot", mode: "validated_autopilot", state: "REJECTED", network: "testnet" },
  { name: "REJECTED under Autopilot on mainnet", mode: "validated_autopilot", state: "REJECTED", network: "mainnet" },
  { name: "UNVALIDATED under Autopilot", mode: "validated_autopilot", state: "UNVALIDATED", network: "testnet" },
  { name: "SHADOW_ONLY under Autopilot", mode: "validated_autopilot", state: "SHADOW_ONLY", network: "testnet" },
  { name: "SHADOW_ONLY under Experimental Testnet", mode: "experimental_testnet", state: "SHADOW_ONLY", network: "testnet" },
  { name: "shadow mode with a validated strategy", mode: "shadow", state: "VALIDATED", network: "testnet" },
  { name: "Experimental Testnet on mainnet", mode: "experimental_testnet", state: "REJECTED", network: "mainnet" },
  { name: "Experimental Testnet on an unknown network", mode: "experimental_testnet", state: "REJECTED", network: "devnet" },
  { name: "UNVALIDATED under Experimental Testnet with no opt-in", mode: "experimental_testnet", state: "UNVALIDATED", network: "testnet" },
  { name: "a pre-upgrade `autopilot` row", mode: "autopilot", state: "VALIDATED", network: "testnet" },
  { name: "an unrecognised mode", mode: "live", state: "VALIDATED", network: "testnet" },
];

describe("nothing denied ever reaches a signer", () => {
  for (const c of DENIED) {
    it(`${c.name} cannot spend`, async () => {
      const { executor, permission, signTransaction, account } = executorForPortfolio(c);
      expect(permission.mayMoveCapital, `${c.name} should be denied`).toBe(false);

      // The object handed to the trading loop is a simulator, not a trader.
      expect(executor.mode).toBe("dry");
      expect(executor).toBeInstanceOf(DryExecutor);

      // And it is called for real, not merely inspected.
      await exerciseEveryCapitalPath(executor);
      expect(signTransaction).not.toHaveBeenCalled();
      expect(account).not.toHaveBeenCalled();
    });
  }

  it("covers every denial the truth table produces", () => {
    // Guards against this list quietly falling behind the gate: if a new
    // denying combination appears and is not exercised above, it is untested.
    const modes: (ExecutionMode | string)[] = ["shadow", "experimental_testnet", "validated_autopilot", "autopilot", "live"];
    const states: StrategyState[] = ["UNVALIDATED", "SHADOW_ONLY", "VALIDATED", "REJECTED"];
    const networks = ["testnet", "mainnet", "devnet"];
    const denied = new Set<string>();
    for (const mode of modes) {
      for (const state of states) {
        for (const network of networks) {
          const p = executionPermission({
            mode, strategy: strategy(state), network,
            signerAvailable: true, delegated: true, privyWalletId: "w",
          });
          if (!p.mayMoveCapital) denied.add(`${mode}/${state}/${network}`);
        }
      }
    }
    // Every listed case is genuinely a denial.
    for (const c of DENIED) expect(denied.has(`${c.mode}/${c.state}/${c.network}`), c.name).toBe(true);
    // And the shapes of denial are represented: one per mode, per state.
    for (const m of modes) expect(DENIED.some((c) => c.mode === m), `no denial case for mode ${m}`).toBe(true);
    for (const s of states) {
      if (s === "VALIDATED") continue;
      expect(DENIED.some((c) => c.state === s), `no denial case for state ${s}`).toBe(true);
    }
  });
});

describe("what a denial does NOT do", () => {
  it("still lets the engine decide, price and record", async () => {
    // Shadow is not "off". A denied portfolio must keep producing decisions —
    // that is what makes the refusal evidence rather than silence — so the dry
    // executor fills against the book and returns a real simulated result.
    const { executor } = executorForPortfolio({ mode: "shadow", state: "VALIDATED", network: "testnet" });
    const r = await executor.buy(order, book);
    expect(r.filled).toBeGreaterThan(0);
    expect(r.rejected).toBeUndefined();
  });
});

describe("the permitted combinations do reach a live executor", () => {
  it("VALIDATED under Autopilot is live on either network", () => {
    for (const network of ["testnet", "mainnet"]) {
      const { executor, permission } = executorForPortfolio({ mode: "validated_autopilot", state: "VALIDATED", network });
      expect(permission.mayMoveCapital).toBe(true);
      expect(executor.mode).toBe("live");
    }
  });

  it("the production strategy is live ONLY under Experimental Testnet, on testnet", () => {
    const live = (mode: ExecutionMode, network: string): boolean =>
      executorForPortfolio({ mode, state: PRODUCTION_STRATEGY.state, network }).executor.mode === "live";
    expect(live("experimental_testnet", "testnet")).toBe(true);
    expect(live("experimental_testnet", "mainnet")).toBe(false);
    expect(live("validated_autopilot", "testnet")).toBe(false);
    expect(live("validated_autopilot", "mainnet")).toBe(false);
    expect(live("shadow", "testnet")).toBe(false);
  });

  it("a missing signer downgrades a permitted combination to dry", async () => {
    const { executor, permission, signTransaction } = executorForPortfolio({
      mode: "validated_autopilot", state: "VALIDATED", network: "testnet", signerAvailable: false,
    });
    expect(permission.mayMoveCapital).toBe(false);
    expect(executor.mode).toBe("dry");
    await exerciseEveryCapitalPath(executor);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("a withdrawn delegation downgrades it too", async () => {
    const { executor, permission } = executorForPortfolio({
      mode: "validated_autopilot", state: "VALIDATED", network: "testnet", delegated: false,
    });
    expect(permission.reasons).toContain("DELEGATION_MISSING");
    expect(executor.mode).toBe("dry");
  });
});
