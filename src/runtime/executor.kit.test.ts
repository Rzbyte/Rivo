// The per-user signing path, exercised against the REAL kit.
//
// Everything else about delegated signing is tested with the credentials absent:
// that an undelegated wallet refuses to build a signer, that a revoked grant
// degrades to Shadow Mode, that nothing displayable can carry a secret. Those
// are the important negative cases and they need no kit.
//
// This is the positive one, and it is the claim the whole product rests on: an
// executor handed a caller-supplied signer really does bind it through
// `ec-core`, and the exchange really does report that account as its wallet. It
// runs the actual `LiveExecutor.load()` path — `createExchange({withSigner:false})`
// followed by `bindSigner` — rather than reasoning about it.
//
// A throwaway key stands in for a Privy account. That substitution is exactly
// the point: the SDK's local-signing path accepts any object with
// `signTransaction`, so a key and a TEE-backed account are the same shape here.
// What this cannot cover is Privy's half — signing a real transaction through
// their API needs credentials and a funded wallet, and is listed as unverified
// in docs/ARCHITECTURE.md rather than implied.
//
// SKIPS when the kit is not installed, which is the normal state of a fresh
// clone. `npm run link:kit` installs it.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LiveExecutor, executorFor, DryExecutor } from "./executor.js";
import type { ChainSigner } from "./signer.js";
import type { Account } from "viem";

/**
 * Is the kit installed?
 *
 * Checked on disk rather than through `require.resolve`. The kit ships raw
 * TypeScript with an `exports` map that publishes only `"."`, so resolving
 * either the subpath or the entry point fails for reasons that have nothing to
 * do with whether it is there — and a skip condition that is wrong in the
 * "skip" direction silently deletes the test.
 */
const kitInstalled = (): boolean =>
  existsSync(fileURLToPath(new URL("../../node_modules/@dreamdex-bot-kit/ec-core/package.json", import.meta.url)));

/** A ChainSigner backed by a key nobody has ever funded. */
async function throwawaySigner(): Promise<ChainSigner & { address: `0x${string}` }> {
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const account: Account = privateKeyToAccount(generatePrivateKey());
  return {
    kind: "privy-delegated",
    address: account.address,
    available: () => true,
    describe: () => ({
      kind: "privy-delegated",
      address: account.address,
      network: "testnet",
      boundedOnChain: false,
      bounds: "test",
    }),
    account: async () => account,
  };
}

describe.skipIf(!kitInstalled())("a caller-supplied signer, through the real kit", () => {
  it("becomes the exchange's wallet", async () => {
    // The single fact the product's architecture depends on. If this breaks, the
    // kit or the SDK has moved and per-user signing is gone — which is why
    // `npm run check:kit` asserts the same thing from the other direction.
    const signer = await throwawaySigner();
    const executor = new LiveExecutor(signer);
    const address = await executor.address();
    expect(address?.toLowerCase()).toBe(signer.address.toLowerCase());
  }, 30_000);

  it("gives two executors two different wallets in one process", async () => {
    // The property that makes a worker fleet possible. Nothing here touches
    // process.env, so two portfolios running side by side sign as two different
    // accounts and neither can change what the other signs with.
    const a = await throwawaySigner();
    const b = await throwawaySigner();
    const [addrA, addrB] = await Promise.all([new LiveExecutor(a).address(), new LiveExecutor(b).address()]);
    expect(addrA?.toLowerCase()).toBe(a.address.toLowerCase());
    expect(addrB?.toLowerCase()).toBe(b.address.toLowerCase());
    expect(addrA).not.toBe(addrB);
  }, 30_000);

  it("does not read PRIVATE_KEY when it was given a signer", async () => {
    // If the injected path silently fell back to the environment, a fleet would
    // trade every user's portfolio from one wallet — and it would look fine.
    const previous = process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY = `0x${"11".repeat(32)}`;
    try {
      const signer = await throwawaySigner();
      const address = await new LiveExecutor(signer).address();
      expect(address?.toLowerCase()).toBe(signer.address.toLowerCase());
    } finally {
      if (previous === undefined) delete process.env.PRIVATE_KEY;
      else process.env.PRIVATE_KEY = previous;
    }
  }, 30_000);

  it("still refuses to go live for an authority that cannot sign", async () => {
    const unusable: ChainSigner = {
      kind: "privy-delegated",
      available: () => false,
      describe: () => ({ kind: "none", address: null, network: "testnet", boundedOnChain: false, bounds: "" }),
      account: async () => {
        throw new Error("not delegated");
      },
    };
    expect(executorFor(unusable, false)).toBeInstanceOf(DryExecutor);
  });
});

describe("kit availability", () => {
  it(kitInstalled() ? "is installed, so the signing path was exercised" : "is absent — run `npm run link:kit` to exercise the signing path", () => {
    expect(true).toBe(true);
  });
});
