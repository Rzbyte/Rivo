// The execution ledger.
//
// WHAT IT FIXES. Provenance used to live on the position: `HeldPosition.txHash`,
// set when an order filled. Closing the position wrote a `ClosedPosition`, which
// has no such field — so the moment a window settled, the transaction that had
// opened it stopped being recorded anywhere. A finished portfolio could show 208
// positions and ten hashes, and `src/cli/proof.ts` already carried a comment
// about working around it. Provenance cannot hang off a mutable object that gets
// replaced; it has to be its own record, written once and kept.
//
// WHAT IT IS. One row per action that touches the chain, written BEFORE the
// action is attempted and never deleted. Positions come and go against it; it
// does not move.
//
// THE STATE MACHINE, and why the order matters:
//
//   intended   the intent is durable, nothing is signed. Crashing here costs
//              nothing at all — there is no transaction to be confused about.
//   submitted  handed to the chain, hash known. Crashing here is the dangerous
//              case, and the reason the row exists: recovery has a hash to ask
//              the chain about instead of a silence to guess at.
//   confirmed  receipt seen. Fill, price and block recorded.
//   failed     rejected before submission, or reverted after it, with the reason.
//   orphaned   submitted (or possibly submitted) and no receipt could be found.
//
// `orphaned` is deliberately not a synonym for `failed`. Calling an unknown
// outcome a failure is a guess in the one direction that causes a duplicate
// trade, and the whole point of this file is to not do that. An orphan says "we
// do not know", stays queryable, and hands the question to reconciliation, which
// answers it from the outcome-token contract rather than from hope.

import type { Leg } from "../engine/book.js";

export type ExecutionAction =
  | "BUY"
  | "SELL"
  | "REDUCE"
  | "EXIT"
  | "CLAIM"
  | "MINT_SET"
  | "MERGE_SET"
  | "APPROVE"
  | "CANCEL";

export type ExecutionStatus = "intended" | "submitted" | "confirmed" | "failed" | "orphaned";

/** Terminal states. A row in one of these will not be attempted again. */
export const isTerminal = (s: ExecutionStatus): boolean =>
  s === "confirmed" || s === "failed" || s === "orphaned";

/** What is known before anything is signed. */
export interface ExecutionIntent {
  portfolioId: string;
  /**
   * Unique per portfolio. A second attempt at the same intent collides here
   * rather than sending a second transaction.
   *
   * Built by `idempotencyKey` below, which includes the cycle: a retry NEXT
   * cycle is a new intent and is meant to be allowed, because the alternative —
   * a leg that fails once and can never be tried again — is worse. What the key
   * prevents is the same intent being issued twice inside one pass, which is the
   * shape every duplicate-order bug in this class actually takes.
   */
  idempotencyKey: string;
  cycle: number;
  marketId: string;
  action: ExecutionAction;
  leg?: Leg;
  requestedQty?: number;
  requestedPrice?: number;
  /** `dry` records the shadow forward-test; `live` touched the chain. */
  mode: "dry" | "live";
  /** Provenance nothing queries on: the pool approved, the order id that rested. */
  meta?: Record<string, unknown>;
}

export interface ExecutionRecord extends ExecutionIntent {
  id: string;
  status: ExecutionStatus;
  filledQty?: number;
  filledPrice?: number;
  cost?: number;
  txHash?: string;
  blockNumber?: number;
  error?: string;
  /** Unix seconds. */
  createdAt: number;
  submittedAt?: number;
  confirmedAt?: number;
}

/** What a fill looked like once the chain answered. */
export interface Fill {
  filledQty: number;
  filledPrice: number;
  cost: number;
  txHash?: string;
  blockNumber?: number;
  meta?: Record<string, unknown>;
}

export interface ExecutionLedger {
  /** Record an intent. Returns the existing row if this key was already used. */
  intend(intent: ExecutionIntent): Promise<ExecutionRecord>;
  find(portfolioId: string, idempotencyKey: string): Promise<ExecutionRecord | null>;
  /** A transaction is on its way, and this is its hash. */
  submitted(id: string, txHash: string): Promise<void>;
  confirmed(id: string, fill: Fill): Promise<void>;
  failed(id: string, error: string, meta?: Record<string, unknown>): Promise<void>;
  /** Submitted, outcome unknown. Not the same as failed — see the header. */
  orphaned(id: string, reason: string): Promise<void>;
  /** Rows that are neither terminal nor finished: what recovery has to resolve. */
  unresolved(portfolioId: string): Promise<ExecutionRecord[]>;
  /** Most recent first. The history a user is shown. */
  list(portfolioId: string, limit?: number): Promise<ExecutionRecord[]>;
  /** How many rows exist for this portfolio, ever. */
  count(portfolioId: string): Promise<number>;
  close?(): Promise<void>;
}

/**
 * The key that makes an intent identifiable.
 *
 * Deliberately does NOT include size or price. Two attempts at the same leg in
 * the same cycle are the same intent even if the second one recomputed a
 * slightly different size — and treating them as different is precisely how a
 * retry loop turns into two positions.
 */
export function idempotencyKey(parts: {
  cycle: number;
  action: ExecutionAction;
  marketId: string;
  leg?: Leg;
}): string {
  return [parts.cycle, parts.action, parts.marketId.toLowerCase(), parts.leg ?? "-"].join(":");
}
