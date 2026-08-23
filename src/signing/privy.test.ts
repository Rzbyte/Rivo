// Autonomous signing: what it claims, and what it refuses to claim.
//
// These are mostly negative tests, and deliberately so. The dangerous failure in
// this module is not "it does not work" — that is loud. It is "it works and
// says something reassuring that is not true", which is silent, and which is
// what a user reads before deciding to fund a wallet.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGIN_METHODS, POLICY_INTENT, PrivyDelegatedAuthority, enabledMethods, looksRevoked, preflight, privyConfigured, resetPrivyClient, verifyAccessToken } from "./privy.js";
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
  set("NEXT_PUBLIC_PRIVY_APP_ID", undefined);
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

describe("the preflight", () => {
  it("names every missing variable rather than failing at the first", async () => {
    // An operator setting this up should get the whole list once, not one item
    // per attempt.
    const p = await preflight();
    expect(p.configured).toBe(false);
    expect(p.reachable).toBeNull();
    const joined = p.problems.join(" ");
    expect(joined).toContain("PRIVY_APP_ID");
    expect(joined).toContain("PRIVY_APP_SECRET");
    expect(joined).toContain("NEXT_PUBLIC_PRIVY_APP_ID");
  });

  it("does not contact Privy when there is nothing to try", async () => {
    // `reachable: null` is "not attempted", which is different from "failed" and
    // must not be reported as a rejection.
    const p = await preflight();
    expect(p.reachable).toBeNull();
    expect(p.problems.join(" ")).not.toMatch(/rejected these credentials/);
  });

  it("reports enabled methods rather than judging them", async () => {
    // Rivo shows whatever the dashboard turned on, so a method being off is the
    // operator's choice and not a fault. The only real failure is none at all.
    const { enabled, disabled } = enabledMethods({ emailAuth: true, walletAuth: true, googleOAuth: false });
    expect(enabled).toEqual(["email", "wallet"]);
    expect(disabled).toContain("google");
    expect(disabled).toContain("passkey");
    expect(enabled.length + disabled.length).toBe(LOGIN_METHODS.length);
  });

  it("treats a flag that is merely present as off", () => {
    // Privy omits flags it has no opinion on, and `undefined` is not `true`.
    const { enabled } = enabledMethods({ emailAuth: undefined, googleOAuth: "yes" as unknown as boolean });
    expect(enabled).toEqual([]);
  });

  it("catches a browser and server pointed at two different apps", async () => {
    // The mistake that produces a sign-in which works and a token the server
    // will not accept — and nothing anywhere says why.
    set("PRIVY_APP_ID", "app-server");
    set("PRIVY_APP_SECRET", "secret");
    set("NEXT_PUBLIC_PRIVY_APP_ID", "app-browser");
    const p = await preflight();
    expect(p.problems.join(" ")).toMatch(/two different apps/);
  });

  it("treats a missing authorization key as advice, not a failure", async () => {
    set("PRIVY_APP_ID", "app");
    set("PRIVY_APP_SECRET", "secret");
    set("NEXT_PUBLIC_PRIVY_APP_ID", "app");
    const p = await preflight();
    expect(p.authorizationKey).toBe(false);
    const advisory = p.problems.filter((x) => x.startsWith("PRIVY_AUTHORIZATION_KEY"));
    expect(advisory).toHaveLength(1);
    expect(advisory[0]).toMatch(/recommended/);
  });

  it("carries no secret in what it reports", async () => {
    set("PRIVY_APP_ID", "app");
    set("PRIVY_APP_SECRET", "secret-that-must-not-leak");
    set("PRIVY_AUTHORIZATION_KEY", "authkey-that-must-not-leak");
    set("NEXT_PUBLIC_PRIVY_APP_ID", "app");
    const p = await preflight();
    const serialised = JSON.stringify(p);
    expect(serialised).not.toContain("secret-that-must-not-leak");
    expect(serialised).not.toContain("authkey-that-must-not-leak");
  });
});

describe("telling a withdrawn grant from a bad afternoon", () => {
  // The distinction decides whether a user gets switched off. A revocation
  // should pause Autopilot and clear the grant; a timeout must not, or a flaky
  // network becomes a product that turns itself off.
  it("recognises a withdrawn grant", () => {
    for (const message of [
      "wallet is not delegated to this app",
      "Delegation for this wallet has been revoked",
      "401 Unauthorized",
      "user is not authorized for this action",
      "403 Forbidden",
      "wallet not found",
    ]) {
      expect(looksRevoked(new Error(message)), message).toBe(true);
    }
  });

  it("does NOT treat a transient failure as a revocation", () => {
    for (const message of [
      "fetch failed",
      "ETIMEDOUT",
      "socket hang up",
      "502 Bad Gateway",
      "rate limit exceeded",
      "ECONNRESET",
      "internal server error",
    ]) {
      expect(looksRevoked(new Error(message)), message).toBe(false);
    }
  });

  it("errs toward transient for anything it does not recognise", () => {
    // The safer direction: retry next cycle rather than switch a user off on an
    // error nobody anticipated.
    expect(looksRevoked(new Error("something nobody has seen before"))).toBe(false);
    expect(looksRevoked("a bare string")).toBe(false);
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
