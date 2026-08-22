// The seam between the engine and wherever its state lives.
//
// Kept as two tiny interfaces rather than one big store, because that is exactly
// what `cycle()` already needed: something to save state into, and something to
// append decisions to. Both are satisfied structurally by the classes that
// already existed — `StateStore` and `DecisionLog` in runtime/state.ts — so
// introducing this changed no behaviour and no test, which is the point. The
// file path stays the development, backtest and single-user path forever.
//
// Both return `void | Promise<void>` on purpose. The file implementations are
// synchronous and there is no reason to make them pretend otherwise; the
// database ones are not. Callers `await`, which is correct for both.

import type { DecisionRecord, RivoState } from "../runtime/state.js";

export interface StateSink {
  save(state: RivoState): void | Promise<void>;
}

export interface DecisionSink {
  append(records: DecisionRecord[]): void | Promise<void>;
}

/**
 * Raised when a save loses a race it should never have been in.
 *
 * The lease is the real defence against two workers on one portfolio; this is
 * the assertion behind it. If it ever fires in production, the lease logic has a
 * bug and the correct response is to abandon the cycle, not to retry — the
 * in-memory state was built from a snapshot that is no longer current, and
 * writing it would overwrite whoever did the work.
 */
export class StaleStateError extends Error {
  constructor(
    readonly portfolioId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `portfolio ${portfolioId} was modified by someone else — expected version ${expectedVersion}. ` +
        `Abandoning this cycle rather than overwriting it.`,
    );
    this.name = "StaleStateError";
  }
}
