// Autonomous signing, without Rivo ever holding a key.
//
// THE PROBLEM THIS SOLVES, stated precisely, because the repository's previous
// answer to it was "you cannot" and that answer was half right.
//
// Rivo's premise is a portfolio managed across settlements that land at 3am. A
// browser wallet cannot do that — a closed tab signs nothing — so an unattended
// manager needs authority to sign while its user is asleep. The obvious way to
// get that is to hold the user's key, and it is unacceptable: a hosted product
// holding strangers' keys is one breach away from being a theft.
//
// The venue offers no on-chain answer. The deployed BinaryPool contains
// `placeBinaryOrderFor` and `cancelOrderFor` and both revert `0x3fb0ba2e` from
// every caller tried, the owner acting for itself included, while each parameter
// mistake returns a selector of its own. Compiled in, switched off. Reproduce it
// in a minute with `npm run probe:operator`; the reading is docs/SDK-FEEDBACK.md
// §9. Nothing here changes that and nothing here pretends to.
//
// But on-chain scoping and key custody are different questions, and the second
// one does have an answer. Read the SDK rather than assuming it:
//
//   markets-sdk/dist/writer.js
//     else if (typeof config.account === "object" && "signTransaction" in config.account)
//         localAccount = config.account;
//
//   markets-sdk/dist/unified/exchange.d.ts
//     setSigner(signer: Pick<TraderConfig, "privateKey" | "account" | "walletClient">): void;
//
//   @privy-io/server-auth/viem
//     declare const createViemAccount: (input: {walletId, address, privy}) => Promise<LocalAccount>;
//
// Any object with `signTransaction` is accepted as the SDK's local-signing path,
// and Privy's server SDK returns exactly that — a viem account whose
// `signTransaction` is an authenticated call into a TEE that holds the key
// share. So the key lives with Privy, the user grants Rivo a revocable right to
// ask for signatures, and Rivo's database holds an address and a wallet id.
//
// WHAT IS AND IS NOT ENFORCED. Stated in one place, and repeated in the UI,
// because overclaiming here would be the most damaging dishonesty in the product:
//
//   ON-CHAIN        nothing. The venue's operator entrypoint is disabled.
//   BY CUSTODY      Rivo cannot exfiltrate the key because it never has it. A
//                   compromise of Rivo's servers gets an attacker the ability to
//                   ASK Privy to sign, for as long as delegation stands and no
//                   longer — not the key, and not anything after revocation.
//   BY POLICY       Privy transaction policies, when configured, are enforced by
//                   Privy at signing time. Rivo declares the policy it wants;
//                   see `POLICY_INTENT` below and read it as a request, not a
//                   guarantee, unless your dashboard shows it attached.
//   BY SOFTWARE     capital ceiling, correlated delta budget, expiry buckets,
//                   tenor caps, drawdown breaker, kill switch. Real, and exactly
//                   as strong as Rivo's own correctness.
//   BY ARITHMETIC   the portfolio wallet holds only what the user funded it with.
//
// NOTHING in this module returns key material, and there is no field on anything
// it exports that could carry one.

import type { Account } from "viem";
import type { AuthorityDescription, ChainSigner } from "../runtime/signer.js";
import { network, type Network } from "../core/config.js";
import { loadEnv } from "../core/env.js";

/** The wallet Rivo is being asked to sign for. An address and an id, nothing more. */
export interface DelegatedWallet {
  /** Privy's identifier for the wallet. Required to sign. */
  walletId: string;
  address: `0x${string}`;
}

/** Whether server-side signing is configured at all. */
export function privyConfigured(): boolean {
  loadEnv();
  return Boolean(process.env.PRIVY_APP_ID?.trim() && process.env.PRIVY_APP_SECRET?.trim());
}

/**
 * What Rivo asks Privy to enforce on a portfolio wallet.
 *
 * Declared as data rather than prose so it can be asserted against in a test and
 * shown in the UI, and so that the day the venue enables its operator entrypoint
 * this becomes the on-chain scope rather than a second thing to write.
 *
 * IMPORTANT: this is Rivo's REQUEST. Whether it is in force depends on the
 * policy being attached to the wallet in the Privy dashboard or via the policy
 * API, which is an operator action Rivo cannot perform on the operator's behalf.
 * `describe()` says "requested" rather than "enforced" for that reason.
 */
export const POLICY_INTENT = {
  chains: ["eip155:50312", "eip155:5031"],
  allow: [
    "ERC-20 approve, to a DreamDEX BinaryPool, for the venue's collateral token",
    "BinaryPool placeBinaryOrder / cancelOrder",
    "BinaryMarketsModule complete-set mint and merge",
    "BinarySettlement redeem / claim",
  ],
  deny: [
    "native transfers to any address",
    "ERC-20 transfer and transferFrom",
    "approvals to anything that is not a DreamDEX pool",
  ],
} as const;

/**
 * The slice of Privy's server client Rivo calls.
 *
 * Declared locally, the same way `ec-core`'s surface is in
 * src/runtime/ec-core-types.ts, and for a sharper reason here: the package ships
 * two parallel declaration trees (one for `require`, one for `import`) whose
 * `PrivyClient` classes are structurally identical and nominally distinct, so
 * annotating with either one produces a type error at the boundary with the
 * other. A narrow structural type sidesteps that and documents exactly how much
 * of the SDK this codebase depends on — which is two methods.
 */
export interface PrivyServer {
  verifyAuthToken(token: string): Promise<{ userId: string }>;
  /** App configuration, as Privy holds it. Used by the preflight to check the setup. */
  getAppSettings(): Promise<{
    id?: string;
    name?: string;
    emailAuth?: boolean;
    googleOAuth?: boolean;
    walletAuth?: boolean;
  }>;
}

/** What a deployment needs before any of this works, and whether it has it. */
export interface PrivyPreflight {
  configured: boolean;
  /** Reached Privy and authenticated. Null when there was nothing to try. */
  reachable: boolean | null;
  appId: string | null;
  appName: string | null;
  loginMethods: { email: boolean; google: boolean; wallet: boolean };
  /** True when an authorization keypair is configured on this server. */
  authorizationKey: boolean;
  problems: string[];
}

/**
 * Check the Privy setup for real, rather than describing it.
 *
 * The point of this is that "did I configure Privy correctly" should be a
 * command with an answer, not a thing an operator discovers when a user's first
 * Autopilot attempt fails. It authenticates against Privy with the server's own
 * credentials and reports what the app actually has enabled — so a missing login
 * method or a wrong secret is caught before a person meets it.
 *
 * It never signs anything and never touches a user's wallet.
 */
export async function preflight(): Promise<PrivyPreflight> {
  loadEnv();
  const appId = process.env.PRIVY_APP_ID?.trim() ?? "";
  const out: PrivyPreflight = {
    configured: privyConfigured(),
    reachable: null,
    appId: appId || null,
    appName: null,
    loginMethods: { email: false, google: false, wallet: false },
    authorizationKey: Boolean(process.env.PRIVY_AUTHORIZATION_KEY?.trim()),
    problems: [],
  };

  if (!appId) out.problems.push("PRIVY_APP_ID is not set — the server cannot talk to Privy.");
  if (!process.env.PRIVY_APP_SECRET?.trim()) out.problems.push("PRIVY_APP_SECRET is not set — the server cannot talk to Privy.");
  const publicAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  if (!publicAppId) {
    out.problems.push("NEXT_PUBLIC_PRIVY_APP_ID is not set — the browser cannot show a sign-in.");
  } else if (appId && publicAppId !== appId) {
    out.problems.push(
      "NEXT_PUBLIC_PRIVY_APP_ID does not match PRIVY_APP_ID — the browser and the server would be talking to two different apps.",
    );
  }
  if (!out.authorizationKey) {
    out.problems.push(
      "PRIVY_AUTHORIZATION_KEY is not set. Optional, and recommended: with an authorization keypair registered, " +
        "a stolen app secret alone cannot move a wallet.",
    );
  }
  if (!out.configured) return out;

  try {
    const privy = await privyClient();
    const settings = await privy.getAppSettings();
    out.reachable = true;
    out.appName = settings.name ?? null;
    out.loginMethods = {
      email: settings.emailAuth === true,
      google: settings.googleOAuth === true,
      wallet: settings.walletAuth === true,
    };
    for (const [name, enabled] of Object.entries(out.loginMethods)) {
      if (!enabled) out.problems.push(`${name} login is not enabled on this Privy app — Rivo's sign-in offers it.`);
    }
  } catch (e) {
    out.reachable = false;
    out.problems.push(
      `Privy rejected these credentials: ${e instanceof Error ? e.message : String(e)}. ` +
        `Check PRIVY_APP_ID and PRIVY_APP_SECRET against the dashboard.`,
    );
  }
  return out;
}

// The client is expensive to build and safe to share, so it is built once. It is
// deliberately not built at import time: every read-only command in this
// repository imports things that import this, and none of them should fail
// because a hosting credential is absent.
let cached: unknown = null;

/** The Privy server client, or an error naming exactly what is missing. */
export async function privyClient(): Promise<PrivyServer> {
  loadEnv();
  const appId = process.env.PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error(
      "server-side signing needs PRIVY_APP_ID and PRIVY_APP_SECRET. " +
        "Without them Rivo can run Shadow Mode and every read-only command, but not Autopilot.",
    );
  }
  if (cached) return cached as PrivyServer;
  const { PrivyClient } = await import("@privy-io/server-auth");
  const authorizationPrivateKey = process.env.PRIVY_AUTHORIZATION_KEY?.trim();
  cached = new PrivyClient(appId, appSecret, {
    // Required whenever the app has an authorization keypair registered, which
    // is the configuration a production deployment should be in: it means a
    // stolen app secret alone cannot move a wallet.
    ...(authorizationPrivateKey ? { walletApi: { authorizationPrivateKey } } : {}),
  });
  return cached as PrivyServer;
}

/** Drop the cached client. Tests, and a credential rotation. */
export function resetPrivyClient(): void {
  cached = null;
}

/**
 * Verify a Privy access token and return the DID it belongs to.
 *
 * The ONLY place a token is turned into an identity. Every authenticated route
 * goes through here, so there is exactly one function to audit rather than one
 * per endpoint — and it returns a DID and nothing else, so a route cannot
 * accidentally trust a claim the token merely carried.
 */
export async function verifyAccessToken(token: string): Promise<{ userId: string } | null> {
  if (!token || token.length > 4096) return null;
  try {
    const privy = await privyClient();
    const claims = await privy.verifyAuthToken(token);
    return { userId: claims.userId };
  } catch {
    // Deliberately opaque. The caller gets "not authenticated"; the reason a
    // token failed is not something an unauthenticated caller should learn.
    return null;
  }
}

/**
 * Does this error mean the grant is gone?
 *
 * Privy's API rejects a signing request for a wallet the app is no longer
 * delegated over, and the two cases Rivo has to tell apart are "the user
 * revoked" and "the network hiccuped" — because the first should stop Autopilot
 * and the second must not. Matched on the shape of the message rather than a
 * code, deliberately narrow: anything unrecognised is treated as transient,
 * which errs toward retrying rather than toward switching a user off.
 */
export function looksRevoked(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("not delegated") ||
    message.includes("delegation") ||
    message.includes("unauthorized") ||
    message.includes("not authorized") ||
    message.includes("forbidden") ||
    message.includes("no owner") ||
    message.includes("wallet not found")
  );
}

/**
 * Authority to sign for one user's portfolio wallet, granted by that user.
 *
 * Constructed per portfolio, not per process. A worker managing forty
 * portfolios holds forty of these and they share nothing but the HTTP client.
 */
export class PrivyDelegatedAuthority implements ChainSigner {
  readonly kind = "privy-delegated" as const;
  private built: Account | null = null;

  constructor(
    private readonly wallet: DelegatedWallet,
    /**
     * Whether the user's grant currently stands, as Rivo's database records it.
     *
     * Passed in rather than looked up, so that the caller has to have read it
     * from somewhere. A default of `true` here would make "forgot to check
     * delegation" indistinguishable from "checked, and it holds".
     */
    private readonly delegated: boolean,
    private readonly net: Network = network(),
  ) {}

  available(): boolean {
    return privyConfigured() && this.delegated && Boolean(this.wallet.walletId);
  }

  /**
   * The signer, as viem sees it.
   *
   * Every `signTransaction` on the returned account is a round trip to Privy,
   * which is a real cost on the hot path — an order is one signature and a claim
   * sweep is several. It is cached per authority for that reason, and the
   * authority itself lives for one cycle.
   */
  async account(): Promise<Account> {
    if (this.built) return this.built;
    if (!this.delegated) {
      throw new Error(
        `wallet ${this.wallet.address} is not delegated to Rivo. The user must enable Autopilot before it can sign.`,
      );
    }
    const privy = await privyClient();
    const { createViemAccount } = await import("@privy-io/server-auth/viem");
    this.built = await createViemAccount({
      walletId: this.wallet.walletId,
      address: this.wallet.address,
      // The cast crosses the two declaration trees described on `PrivyServer`.
      // It is the same object either way — this is the SDK's own client.
      privy: privy as Parameters<typeof createViemAccount>[0]["privy"],
    });
    return this.built;
  }

  describe(): AuthorityDescription {
    const configured = privyConfigured();
    const base: AuthorityDescription = {
      kind: this.available() ? "privy-delegated" : "none",
      address: this.wallet.address,
      network: this.net,
      // FALSE, and this is the field most likely to be read by something that
      // then tells a user their funds are protected by the chain. They are not.
      // The protection here is custodial and revocable, which is a different and
      // weaker claim, so the boolean says what it means.
      boundedOnChain: false,
      bounds:
        "Rivo can ask Privy to sign for this wallet, and can do nothing else with it. " +
        "It never holds the key. The grant is revocable by the user at any time, and revoking it " +
        "stops Autopilot immediately. Trading limits are enforced by Rivo in software; the venue " +
        "offers no on-chain scope for Event Contracts (docs/SDK-FEEDBACK.md §9).",
    };
    if (!configured) {
      return { ...base, missing: "PRIVY_APP_ID and PRIVY_APP_SECRET are not set on this server." };
    }
    if (!this.delegated) {
      return { ...base, missing: "the user has not granted Rivo signing authority over this wallet." };
    }
    return base;
  }
}
