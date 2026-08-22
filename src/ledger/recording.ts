// Every chain action, recorded before it is attempted.
//
// A decorator rather than a change to the executors, for two reasons. The live
// executor is the most dangerous file in the repository and adding bookkeeping
// to it would mean rereading it every time the bookkeeping changed. And the dry
// executor gets the same treatment for free, which is what makes Shadow Mode
// produce a real forward-test record rather than a log line.
//
// THE ORDER OF OPERATIONS IS THE POINT:
//
//   1. write the intent            durable, nothing signed
//   2. call the inner executor     the transaction happens here, or does not
//   3. write the outcome           confirmed, or failed, with the reason
//
// A crash between 1 and 3 leaves a row that is not terminal, which is what
// `recover()` below exists to resolve. It resolves it by asking the chain, and
// where the chain cannot answer it says so — see `orphaned` in types.ts, and the
// limitation stated honestly at the bottom of this file.

import type { Executor, OrderRequest, OrderResult } from "../runtime/executor.js";
import type { MarketBook } from "../engine/book.js";
import type { ReceiptReader } from "../runtime/receipt.js";
import {
  idempotencyKey,
  type ExecutionAction,
  type ExecutionLedger,
  type ExecutionRecord,
} from "./types.js";

export interface RecordingContext {
  portfolioId: string;
  ledger: ExecutionLedger;
  /** Called for anything an operator should see. */
  note?: (message: string) => void;
}

/**
 * How long a row may sit unresolved before recovery gives up on identifying it.
 *
 * Generous. The cost of waiting is a row that says "unknown" for longer; the
 * cost of concluding too early is a duplicate order.
 */
export const ORPHAN_AFTER_SEC = 900;

export class RecordingExecutor implements Executor {
  /** Set by the loop at the top of every pass, so keys are scoped to a cycle. */
  private cycleNo = 0;

  constructor(
    private readonly inner: Executor,
    private readonly ctx: RecordingContext,
  ) {}

  get mode(): "dry" | "live" {
    return this.inner.mode;
  }

  /** The executor being recorded, for the few callers that configure it directly. */
  get target(): Executor {
    return this.inner;
  }

  newCycle(cycle?: number): void {
    if (typeof cycle === "number") this.cycleNo = cycle;
    this.inner.newCycle(cycle);
  }

  address(): Promise<string | null> {
    return this.inner.address();
  }

  isTradable(marketId: string): Promise<boolean> {
    return this.inner.isTradable(marketId);
  }

  /**
   * Run one chain action inside a ledger row.
   *
   * `already` is the case that makes this worth having: a terminal row for this
   * key means the action was attempted in this cycle and settled, so repeating
   * it would be the duplicate the ledger exists to prevent. The recorded result
   * is replayed instead.
   */
  private async record(
    action: ExecutionAction,
    marketId: string,
    leg: OrderRequest["leg"] | undefined,
    requested: { qty?: number; price?: number },
    run: () => Promise<OrderResult>,
  ): Promise<OrderResult> {
    const key = idempotencyKey({ cycle: this.cycleNo, action, marketId, leg });
    const prior = await this.ctx.ledger.find(this.ctx.portfolioId, key);
    if (prior && (prior.status === "confirmed" || prior.status === "failed")) {
      this.ctx.note?.(`skipping duplicate ${action} on ${marketId.slice(0, 10)}… — already ${prior.status} this cycle`);
      return replay(prior);
    }
    if (prior && (prior.status === "submitted" || prior.status === "orphaned")) {
      // In flight, or in flight and unaccounted for. Either way the one thing
      // that must not happen is a second transaction.
      this.ctx.note?.(
        `refusing to repeat ${action} on ${marketId.slice(0, 10)}… — a previous attempt is ${prior.status}` +
          (prior.txHash ? ` (tx ${prior.txHash})` : ""),
      );
      return { filled: 0, avgPrice: 0, cost: 0, rejected: `an earlier attempt is ${prior.status}` };
    }

    const row = await this.ctx.ledger.intend({
      portfolioId: this.ctx.portfolioId,
      idempotencyKey: key,
      cycle: this.cycleNo,
      marketId,
      action,
      mode: this.inner.mode,
      ...(leg ? { leg } : {}),
      ...(requested.qty !== undefined ? { requestedQty: requested.qty } : {}),
      ...(requested.price !== undefined ? { requestedPrice: requested.price } : {}),
    });

    let res: OrderResult;
    try {
      res = await run();
    } catch (e) {
      await this.ctx.ledger.failed(row.id, e instanceof Error ? e.message : String(e));
      throw e;
    }

    if (res.txHash) await this.ctx.ledger.submitted(row.id, res.txHash);
    if (res.rejected && res.filled <= 0 && !res.rested) {
      await this.ctx.ledger.failed(row.id, res.rejected);
    } else {
      await this.ctx.ledger.confirmed(row.id, {
        filledQty: res.filled,
        filledPrice: res.avgPrice,
        cost: res.cost,
        ...(res.txHash ? { txHash: res.txHash } : {}),
        meta: {
          ...(res.rested ? { rested: true } : {}),
          ...(res.orderId ? { orderId: res.orderId } : {}),
          ...(res.rejected ? { note: res.rejected } : {}),
        },
      });
    }
    return { ...res, executionId: row.id };
  }

  buy(req: OrderRequest, book: MarketBook | undefined): Promise<OrderResult> {
    return this.record("BUY", req.marketId, req.leg, { qty: req.size, price: req.limitPrice }, () =>
      this.inner.buy(req, book),
    );
  }

  sell(req: OrderRequest, book: MarketBook | undefined): Promise<OrderResult> {
    // A sell is a REDUCE or an EXIT depending on why the position manager asked
    // for it, and only the caller knows which. Recording it as plain SELL when
    // nothing said otherwise keeps the ledger honest about what it was told.
    const action: ExecutionAction = req.intent ?? "SELL";
    return this.record(action, req.marketId, req.leg, { qty: req.size, price: req.limitPrice }, () =>
      this.inner.sell(req, book),
    );
  }

  mintSet(marketId: string, amount: number): Promise<OrderResult> {
    return this.record("MINT_SET", marketId, undefined, { qty: amount }, () => this.inner.mintSet(marketId, amount));
  }

  mergeSet(marketId: string, amount: number): Promise<OrderResult> {
    return this.record("MERGE_SET", marketId, undefined, { qty: amount }, () => this.inner.mergeSet(marketId, amount));
  }

  /**
   * A claim sweep is one action over every settled window at once, so it gets
   * one row. The kit's `maybeClaim` reports collateral recovered and not the
   * transactions it sent, so the row records the amount and says nothing about
   * hashes it was never given — rather than inventing a plausible one.
   */
  async claim(): Promise<number> {
    const key = idempotencyKey({ cycle: this.cycleNo, action: "CLAIM", marketId: "sweep" });
    const prior = await this.ctx.ledger.find(this.ctx.portfolioId, key);
    if (prior && prior.status === "confirmed") return prior.filledQty ?? 0;
    const row = await this.ctx.ledger.intend({
      portfolioId: this.ctx.portfolioId,
      idempotencyKey: key,
      cycle: this.cycleNo,
      marketId: "sweep",
      action: "CLAIM",
      mode: this.inner.mode,
    });
    try {
      const recovered = await this.inner.claim();
      await this.ctx.ledger.confirmed(row.id, { filledQty: recovered, filledPrice: 1, cost: 0 });
      return recovered;
    } catch (e) {
      await this.ctx.ledger.failed(row.id, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async cancelResting(): Promise<number> {
    const key = idempotencyKey({ cycle: this.cycleNo, action: "CANCEL", marketId: "all" });
    const row = await this.ctx.ledger.intend({
      portfolioId: this.ctx.portfolioId,
      idempotencyKey: key,
      cycle: this.cycleNo,
      marketId: "all",
      action: "CANCEL",
      mode: this.inner.mode,
    });
    try {
      const n = await this.inner.cancelResting();
      await this.ctx.ledger.confirmed(row.id, { filledQty: n, filledPrice: 0, cost: 0 });
      return n;
    } catch (e) {
      await this.ctx.ledger.failed(row.id, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
}

/** What a previously-settled row says the result was. */
function replay(rec: ExecutionRecord): OrderResult {
  if (rec.status === "failed") {
    return { filled: 0, avgPrice: 0, cost: 0, rejected: rec.error ?? "recorded as failed" };
  }
  return {
    filled: rec.filledQty ?? 0,
    avgPrice: rec.filledPrice ?? 0,
    cost: rec.cost ?? 0,
    ...(rec.txHash ? { txHash: rec.txHash } : {}),
    executionId: rec.id,
  };
}

export interface RecoveryOutcome {
  resolved: number;
  orphaned: number;
  stillPending: number;
  details: string[];
}

/**
 * Resolve everything the last process left in flight.
 *
 * Run at startup, BEFORE the first cycle, so allocation never reasons from a
 * portfolio with unaccounted transactions in it.
 *
 * WHAT THIS CAN AND CANNOT DO, stated plainly because the difference decides
 * whether the product is safe:
 *
 *   * A row with a hash is answerable. The chain is asked, and the row becomes
 *     confirmed or failed on the evidence.
 *   * A row WITHOUT a hash is not answerable from here. The transaction may
 *     never have been signed, or may have been signed and broadcast in the
 *     instant before the crash — the kit returns the hash only after the write
 *     completes, so there is no moment at which Rivo holds a hash for an
 *     in-flight transaction. Such a row becomes `orphaned` once it is old
 *     enough, and the question of what the wallet actually holds is answered
 *     where it can be answered: `reconcile()`, against the outcome-token
 *     contract. That is why a duplicate BUY cannot survive a crash even though
 *     this function cannot always say what happened — the allocator sees the
 *     position on-chain and does not buy it twice.
 */
export async function recover(
  ledger: ExecutionLedger,
  portfolioId: string,
  receipts: ReceiptReader,
  now = Math.floor(Date.now() / 1000),
): Promise<RecoveryOutcome> {
  const out: RecoveryOutcome = { resolved: 0, orphaned: 0, stillPending: 0, details: [] };
  for (const row of await ledger.unresolved(portfolioId)) {
    if (row.txHash) {
      const r = await receipts.receipt(row.txHash);
      if (!r) {
        // Unknown, not absent. Only age decides, and only after long enough that
        // "still propagating" is no longer a plausible explanation.
        if (now - row.createdAt > ORPHAN_AFTER_SEC) {
          await ledger.orphaned(row.id, `no receipt for ${row.txHash} after ${now - row.createdAt}s`);
          out.orphaned++;
          out.details.push(`${row.action} ${row.marketId.slice(0, 10)}… orphaned — tx ${row.txHash} has no receipt`);
        } else {
          out.stillPending++;
        }
        continue;
      }
      if (r.ok) {
        // The fill is not knowable from a receipt alone, so it is left as the
        // intent recorded and the block is what gets added. Reconciliation
        // corrects the position against the chain either way.
        await ledger.confirmed(row.id, {
          filledQty: row.filledQty ?? row.requestedQty ?? 0,
          filledPrice: row.filledPrice ?? row.requestedPrice ?? 0,
          cost: row.cost ?? 0,
          txHash: row.txHash,
          blockNumber: r.blockNumber,
          meta: { recovered: true, fillFromIntent: row.filledQty === undefined },
        });
        out.details.push(`${row.action} ${row.marketId.slice(0, 10)}… confirmed in block ${r.blockNumber}`);
      } else {
        await ledger.failed(row.id, `reverted on-chain in block ${r.blockNumber}`, { recovered: true });
        out.details.push(`${row.action} ${row.marketId.slice(0, 10)}… reverted in block ${r.blockNumber}`);
      }
      out.resolved++;
      continue;
    }

    if (now - row.createdAt > ORPHAN_AFTER_SEC) {
      await ledger.orphaned(
        row.id,
        `no transaction hash was ever recorded; the process ended between intent and result. ` +
          `Position truth for this leg comes from on-chain reconciliation, not from this row.`,
      );
      out.orphaned++;
      out.details.push(`${row.action} ${row.marketId.slice(0, 10)}… orphaned — intent with no hash`);
    } else {
      out.stillPending++;
    }
  }
  return out;
}
