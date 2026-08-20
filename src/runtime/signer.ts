// Where Rivo's authority to trade comes from.
//
// `Executor` already abstracts HOW an order is placed. This abstracts something
// different and, for an autonomous product, more consequential: WHOSE authority
// it is placed under, and what bounds that authority carries.
//
// The distinction matters because the honest answer today is unflattering, and
// burying it inside `makeExecutor` would let the UI imply something better. On
// DreamDEX Event Contracts as of 2026-08, `ec-core` exposes no session-key or
// operator path — `placeOrderFor` / `cancelOrderFor` exist on the SPOT pool
// (packages/core/src/execute.ts) but have no Event Contract counterpart. So the
// only way to trade EC unattended is a raw key that can do anything the account
// can do, and every bound on it is enforced by Rivo's own code rather than by
// the chain.
//
// That is a real limitation, not a design choice, and this file names it so the
// product can display it truthfully:
//
//   RAW_KEY   — full account authority. Bounds are software-enforced only.
//   SESSION   — a scoped key the owner granted, revocable on-chain.  (not yet possible)
//   OPERATOR  — a separate key trading a vault it can never withdraw. (not yet possible)
//
// The two unavailable modes are declared rather than omitted: the interface is
// the shape they will implement, so adopting one is a new `SigningAuthority`
// and a config line, not a rewrite. `docs/SDK-FEEDBACK.md` carries the finding.
//
// NOTHING in this module returns key material. `describe()` is built for display
// and deliberately has no field that could carry one.

import { loadEnv } from "../core/env.js";
import { network, type Network } from "../core/config.js";

export type AuthorityKind = "none" | "raw-key" | "session-key" | "operator";

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
 * The authority Rivo wants, kept here so the gap is visible in code rather than
 * only in prose.
 *
 * An owner would grant a scoped key permission to place and cancel EC orders
 * against a deposited vault, revocable on-chain and unable to withdraw. The spot
 * venue already supports exactly this shape via `placeOrderFor`; Event Contracts
 * do not expose it, so this reports unavailable rather than pretending.
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
      bounds: "Scoped to placing and cancelling Event Contract orders against a deposited vault; cannot withdraw; revocable on-chain.",
      missing:
        "ec-core exposes no placeOrderFor/operator path for Event Contracts (the spot pool does). Not implementable against the current venue.",
    };
  }
}

/** The authority in force, chosen by what the environment can actually support. */
export function authority(): SigningAuthority {
  const env = new EnvKeyAuthority();
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
  if (a instanceof EnvKeyAuthority) return { ...base, address: await a.resolveAddress() };
  return base;
}
