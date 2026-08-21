// Where Rivo's authority to trade comes from.
//
// `Executor` already abstracts HOW an order is placed. This abstracts something
// different and, for an autonomous product, more consequential: WHOSE authority
// it is placed under, and what bounds that authority carries.
//
// The distinction matters because the honest answer today is unflattering, and
// burying it inside `makeExecutor` would let the UI imply something better. On
// DreamDEX Event Contracts as of 2026-08 there is no way to place an order for
// somebody else, so the only unattended authority is a key that can do anything
// the account can do.
//
// That claim used to rest on a grep over `ec-core`, which was weak: an absent
// wrapper is not an absent feature. It now rests on the chain. The deployed
// BinaryPool *contains* `placeBinaryOrderFor` and `cancelOrderFor`, and both
// revert with one selector — `0x3fb0ba2e` — for every caller tried, the owner
// acting for itself included, while each parameter error carries a selector of
// its own. Compiled in, switched off. `npm run probe:operator` re-runs the whole
// differential in about a minute and writes docs/evidence/operator-probe.json;
// the reading is in docs/SDK-FEEDBACK.md §9.
//
// So the modes are:
//
//   RAW_KEY   — full account authority. Bounds are software-enforced only.
//   AGENT     — a raw key that holds nothing but its float. Bounds are the
//               balance itself, which is enforced by arithmetic. Available.
//   SESSION   — a scoped key the owner granted, revocable on-chain.  (venue-blocked)
//   OPERATOR  — a separate key trading a vault it can never withdraw. (venue-blocked)
//
// The two blocked modes are declared rather than omitted: the interface is the
// shape they will implement, so adopting one when the venue enables the
// entrypoint is a new `SigningAuthority` and a config line, not a rewrite.
//
// NOTHING in this module returns key material. `describe()` is built for display
// and deliberately has no field that could carry one.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "../core/env.js";
import { network, type Network } from "../core/config.js";

export type AuthorityKind = "none" | "raw-key" | "agent-wallet" | "session-key" | "operator";

/** What the product may say about the signer. Display-only, by construction. */
export interface AuthorityDescription {
  kind: AuthorityKind;
  /** Address that will appear as the sender on-chain, when one is configured. */
  address: `0x${string}` | null;
  network: Network;
  /** True when the chain itself constrains what this authority can do. */
  boundedOnChain: boolean;
  /** Plain-language statement of the bound, for the UI. */
  bounds: string;
  /** Present when the authority cannot sign at all, explaining what is missing. */
  missing?: string;
}

export interface SigningAuthority {
  readonly kind: AuthorityKind;
  /** Whether this authority can currently sign. */
  available(): boolean;
  /** Display-safe summary. Never includes key material. */
  describe(): AuthorityDescription;
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Derive the address from a private key without pulling in a signing library.
 *
 * viem is already a dependency of the live path, but this module is imported by
 * the web server's status endpoint, which must stay usable with no key present
 * and no crypto loaded. So the import is dynamic and failure is non-fatal: an
 * address is a nicety for display, and not having one must never be the reason
 * a status endpoint 500s.
 */
async function addressFromKey(pk: string): Promise<`0x${string}` | null> {
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    return privateKeyToAccount(pk as `0x${string}`).address.toLowerCase() as `0x${string}`;
  } catch {
    return null;
  }
}

/**
 * The authority Rivo actually runs under today: a private key in the process
 * environment, with every limit enforced in software above it.
 *
 * The bounds are real — capital ceiling, per-asset delta budget, drawdown
 * breaker, kill switch — but they live in Rivo, so they hold exactly as long as
 * Rivo is the only thing holding the key. That is a materially weaker guarantee
 * than an on-chain scope, and it is stated as such.
 */
export class EnvKeyAuthority implements SigningAuthority {
  readonly kind = "raw-key" as const;
  private cachedAddress: `0x${string}` | null = null;

  private key(): string {
    loadEnv();
    return (process.env.PRIVATE_KEY ?? "").trim();
  }

  available(): boolean {
    return KEY_RE.test(this.key());
  }

  /** Resolve the sender address once, for display. */
  async resolveAddress(): Promise<`0x${string}` | null> {
    if (this.cachedAddress) return this.cachedAddress;
    if (!this.available()) return null;
    this.cachedAddress = await addressFromKey(this.key());
    return this.cachedAddress;
  }

  describe(): AuthorityDescription {
    const ok = this.available();
    return {
      kind: ok ? "raw-key" : "none",
      address: this.cachedAddress,
      network: network(),
      boundedOnChain: false,
      bounds: ok
        ? "Full account authority. Capital ceiling, delta budgets, drawdown breaker and kill switch are enforced by Rivo, not by the chain."
        : "No signing authority configured — Shadow Mode only.",
      ...(ok ? {} : { missing: "PRIVATE_KEY is not set to a 32-byte hex key" }),
    };
  }
}

/**
 * A key that holds nothing but the float it was given.
 *
 * This is the honest answer to "production ready" on a venue with no on-chain
 * scoping. It does not make a hot key safe — a hot key is a hot key. It makes
 * the *loss* bounded, and bounds it with arithmetic instead of with a promise:
 * the account cannot lose more than its balance, and its balance is a number the
 * owner chose and can sweep back at any time.
 *
 * Compare what each authority is risking if the machine running it is taken:
 *
 *   raw key from .env  — everything that wallet has ever held.
 *   agent wallet       — the float, and nothing else. No allowance to the
 *                        owner's wallet, no ability to pull more.
 *
 * The distinction is worth a class rather than a comment because the product
 * displays it, and because `authority()` prefers this one when it exists. The
 * key lives on disk beside the process, never in `.env` (so it cannot be
 * committed with one) and never in the browser (so nothing can round-trip it).
 *
 * `npm run agent` creates, funds, inspects and sweeps it.
 */
export class AgentWalletAuthority implements SigningAuthority {
  readonly kind = "agent-wallet" as const;
  private cachedAddress: `0x${string}` | null = null;

  /** Where the key file lives. Overridable so tests never touch a real one. */
  static path(): string {
    return process.env.RIVO_AGENT_KEY_FILE ?? resolve(process.cwd(), ".rivo", "agent.key");
  }

  key(): string {
    try {
      return readFileSync(AgentWalletAuthority.path(), "utf8").trim();
    } catch {
      return "";
    }
  }

  available(): boolean {
    return KEY_RE.test(this.key());
  }

  /**
   * Make this key the one the SDK signs with.
   *
   * `ec-core` builds its signer from `process.env.PRIVATE_KEY` deep inside
   * `createExchange`, with no parameter to override it, so adopting an agent
   * wallet means putting it there before the exchange is constructed. Called
   * from `makeExecutor` at the moment live execution is chosen — never from
   * `describe()`, because a status endpoint must not change what the process
   * would sign with.
   */
  activate(): boolean {
    const k = this.key();
    if (!KEY_RE.test(k)) return false;
    process.env.PRIVATE_KEY = k;
    return true;
  }

  async resolveAddress(): Promise<`0x${string}` | null> {
    if (this.cachedAddress) return this.cachedAddress;
    if (!this.available()) return null;
    this.cachedAddress = await addressFromKey(this.key());
    return this.cachedAddress;
  }

  describe(): AuthorityDescription {
    const ok = this.available();
    return {
      kind: ok ? "agent-wallet" : "none",
      address: this.cachedAddress,
      network: network(),
      // The chain does not scope this key — it simply has nothing else to lose.
      // Calling that "bounded on-chain" would be the exact overstatement this
      // module exists to prevent.
      boundedOnChain: false,
      bounds: ok
        ? "A dedicated wallet holding only its funded float. Maximum loss is that balance — it holds no other assets and no allowance to the owner's wallet. Sweep it back with `npm run agent -- sweep`."
        : "No agent wallet — run `npm run agent -- new`.",
      ...(ok ? {} : { missing: `no key at ${AgentWalletAuthority.path()}` }),
    };
  }
}

/**
 * The authority Rivo wants, kept here so the gap is visible in code rather than
 * only in prose.
 *
 * An owner would grant a scoped key permission to place and cancel EC orders,
 * revocable on-chain and unable to withdraw. The spot venue supports exactly
 * this via `placeOrderFor`. Event Contracts are one step stranger: the deployed
 * BinaryPool *has* `placeBinaryOrderFor` and `cancelOrderFor`, and both are off.
 * See the header, and `npm run probe:operator` for the measurement.
 */
export class SessionKeyAuthority implements SigningAuthority {
  readonly kind = "session-key" as const;
  available(): boolean {
    return false;
  }
  describe(): AuthorityDescription {
    return {
      kind: "session-key",
      address: null,
      network: network(),
      boundedOnChain: true,
      bounds: "Scoped to placing and cancelling Event Contract orders for an owner; cannot withdraw; revocable on-chain.",
      missing:
        "The deployed BinaryPool contains placeBinaryOrderFor and cancelOrderFor, and both revert 0x3fb0ba2e for every caller including the owner acting for itself — while each parameter error carries its own selector. The feature is compiled in and disabled. Measured by `npm run probe:operator`; reading in docs/SDK-FEEDBACK.md §9.",
    };
  }
}

/**
 * The authority in force.
 *
 * An agent wallet wins when one exists, because preferring the key with less to
 * lose is the right default and making the safer option also the automatic one
 * is most of what "secure by default" means. `RIVO_AUTHORITY=env` forces the raw
 * key for anyone who genuinely wants to trade their main wallet.
 */
export function authority(): SigningAuthority {
  const prefer = (process.env.RIVO_AUTHORITY ?? "").trim().toLowerCase();
  const env = new EnvKeyAuthority();
  if (prefer === "env") return env;
  const agent = new AgentWalletAuthority();
  if (agent.available()) return agent;
  if (env.available()) return env;
  const session = new SessionKeyAuthority();
  return session.available() ? session : env;
}

/**
 * Display-safe status for the API, with the sender address resolved.
 *
 * The web layer calls this and nothing else, so there is exactly one path
 * between a key and anything a user can see.
 */
export async function authorityStatus(): Promise<AuthorityDescription> {
  const a = authority();
  const base = a.describe();
  if (a instanceof EnvKeyAuthority || a instanceof AgentWalletAuthority) {
    return { ...base, address: await a.resolveAddress() };
  }
  return base;
}
