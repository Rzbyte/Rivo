// Autonomous signing: what it claims, and what it refuses to claim.
//
// These are mostly negative tests, and deliberately so. The dangerous failure in
// this module is not "it does not work" — that is loud. It is "it works and
// says something reassuring that is not true", which is silent, and which is
// what a user reads before deciding to fund a wallet.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POLICY_INTENT, PrivyDelegatedAuthority, privyConfigured, resetPrivyClient, verifyAccessToken } from "./privy.js";
import { canSign, type SigningAuthority } from "../runtime/signer.js";
import { DryExecutor, executorFor } from "../runtime/executor.js";

const WALLET = { walletId: "pw_test", address: "0x1111111111111111111111111111111111111111" as const };

const saved: Record<string, string | undefined> = {};
const set = (k: string, v: string | undefined) => {
  saved[k] ??= process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

beforeEach(() => {
  resetPrivyClient();
  set("PRIVY_APP_ID", undefined);
  set("PRIVY_APP_SECRET", undefined);
  set("PRIVY_AUTHORIZATION_KEY", undefined);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPrivyClient();
});

describe("configuration", () => {
  it("is not configured when the credentials are absent", () => {
    expect(privyConfigured()).toBe(false);
  });

  it("needs BOTH the app id and the secret", () => {
    set("PRIVY_APP_ID", "app123");
    expect(privyConfigured()).toBe(false);
    set("PRIVY_APP_SECRET", "secret123");
    expect(privyConfigured()).toBe(true);
  });

  it("treats whitespace as absent, because a blank line in a .env is not a credential", () => {
    set("PRIVY_APP_ID", "   ");
    set("PRIVY_APP_SECRET", "secret123");
    expect(privyConfigured()).toBe(false);
  });
});

describe("the delegated authority", () => {
  it("cannot sign when the server has no credentials", () => {
    expect(new PrivyDelegatedAuthority(WALLET, true).available()).toBe(false);
  });

  it("cannot sign when the user has not granted authority", () => {
    set("PRIVY_APP_ID", "app123");
    set("PRIVY_APP_SECRET", "secret123");
    expect(new PrivyDelegatedAuthority(WALLET, false).available()).toBe(false);
    expect(new PrivyDelegatedAuthority(WALLET, true).available()).toBe(true);
  });

  it("REFUSES to build a signer for a wallet that is not delegated", async () => {
    set("PRIVY_APP_ID", "app123");
    set("PRIVY_APP_SECRET", "secret123");
    await expect(new PrivyDelegatedAuthority(WALLET, false).account()).rejects.toThrow(/not delegated/i);
  });

  it("does NOT claim the chain is bounding it", () => {
    // The single most consequential field in the module. The venue's operator
    // entrypoint is compiled in and disabled (probe:operator), so nothing about
    // this authority is enforced on-chain, and a `true` here would end up in a
    // UI telling a user their funds are protected by something that does not
    // exist.
    set("PRIVY_APP_ID", "app123");
    set("PRIVY_APP_SECRET", "secret123");
    const d = new PrivyDelegatedAuthority(WALLET, true).describe();
    expect(d.boundedOnChain).toBe(false);
    expect(d.bounds).toMatch(/never holds the key/i);
    expect(d.bounds).toMatch(/revocable/i);
    expect(d.bounds).toMatch(/software/i);
  });

  it("says what is missing, differently for the two ways of being unable to sign", () => {
    const noCreds = new PrivyDelegatedAuthority(WALLET, true).describe();
    expect(noCreds.kind).toBe("none");
    expect(noCreds.missing).toMatch(/PRIVY_APP_ID/);

    set("PRIVY_APP_ID", "app123");
    set("PRIVY_APP_SECRET", "secret123");
    const notGranted = new PrivyDelegatedAuthority(WALLET, false).describe();
    expect(notGranted.kind).toBe("none");
    expect(notGranted.missing).toMatch(/has not granted/i);
  });

  it("carries no field that could hold key material", () => {
    set("PRIVY_APP_ID", "app123");
    set("PRIVY_APP_SECRET", "secret-that-must-not-leak");
    set("PRIVY_AUTHORIZATION_KEY", "authkey-that-must-not-leak");
    const d = new PrivyDelegatedAuthority(WALLET, true).describe();
    const serialised = JSON.stringify(d);
    expect(serialised).not.toContain("secret-that-must-not-leak");
    expect(serialised).not.toContain("authkey-that-must-not-leak");
    expect(serialised).not.toContain("pw_test"); // not even the wallet id
    expect(Object.keys(d).sort()).toEqual(["address", "boundedOnChain", "bounds", "kind", "network"]);
  });

  it("is a ChainSigner, and a plain authority is not", () => {
    const delegated: SigningAuthority = new PrivyDelegatedAuthority(WALLET, true);
    expect(canSign(delegated)).toBe(true);
    const displayOnly: SigningAuthority = {
      kind: "session-key",
      available: () => false,
      describe: () => ({ kind: "session-key", address: null, network: "testnet", boundedOnChain: true, bounds: "" }),
    };
    expect(canSign(displayOnly)).toBe(false);
  });
});

describe("token verification", () => {
  it("rejects an empty or absurd token without calling anything", async () => {
    expect(await verifyAccessToken("")).toBeNull();
    expect(await verifyAccessToken("x".repeat(5000))).toBeNull();
  });

  it("returns null rather than an explanation when verification fails", async () => {
    // An unauthenticated caller learns "no". Why is not theirs to know, and a
    // thrown error carrying the reason is how that leaks.
    set("PRIVY_APP_ID", "app123");
    set("PRIVY_APP_SECRET", "secret123");
    expect(await verifyAccessToken("not-a-real-token")).toBeNull();
  });
});

describe("choosing an executor per portfolio", () => {
  const unusable = new PrivyDelegatedAuthority(WALLET, false);

  it("falls back to Shadow Mode when the user has not granted authority", () => {
    // A revoked grant must degrade to simulation, not to an error and not to
    // trading. Both of the other options are worse than this one.
    expect(executorFor(unusable, false)).toBeInstanceOf(DryExecutor);
  });

  it("stays dry when asked to, whatever the authority says", () => {
    set("PRIVY_APP_ID", "app123");
    set("PRIVY_APP_SECRET", "secret123");
    expect(executorFor(new PrivyDelegatedAuthority(WALLET, true), true)).toBeInstanceOf(DryExecutor);
  });
});

describe("the policy Rivo asks Privy to enforce", () => {
  it("names both Somnia chains and no others", () => {
    expect(POLICY_INTENT.chains).toEqual(["eip155:50312", "eip155:5031"]);
  });

  it("denies every path that could move funds out of the portfolio wallet", () => {
    const denied = POLICY_INTENT.deny.join(" ").toLowerCase();
    expect(denied).toContain("native transfers");
    expect(denied).toContain("transferfrom");
    // An approval to something that is not a pool is how a drainer gets paid,
    // and it is the one that looks innocuous next to the approvals Rivo does need.
    expect(denied).toContain("approvals to anything that is not a dreamdex pool");
  });

  it("allows exactly the four things a portfolio manager has to do", () => {
    expect(POLICY_INTENT.allow).toHaveLength(4);
    const allowed = POLICY_INTENT.allow.join(" ").toLowerCase();
    for (const need of ["approve", "placebinaryorder", "mint", "redeem"]) {
      expect(allowed).toContain(need);
    }
  });
});
