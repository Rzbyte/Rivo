// The chain, asked directly.
//
// Reconciliation is built on the sentence "the chain is the authority on what is
// held". It was not true. Holdings came from the indexer's `OutcomeBalance`
// table, and an indexed table is a copy — it lags, and it lags in both
// directions, each with its own way of costing money:
//
//   * stale LOW — a fill lands, the row has not appeared yet, Rivo sees nothing
//     where it holds something. Past the grace window that becomes a DROP: the
//     portfolio forgets a position it owns and is free to buy a second copy.
//     Documented in docs/SDK-FEEDBACK.md §8, where it already cost ~400
//     collateral in re-minted inventory.
//
//   * stale HIGH — a position settles and its tokens are burned, but the row
//     lingers. Rivo sees an asset that no longer exists. On a live window that
//     becomes an ADOPT, inventing a position and crediting `contributed` with
//     value nothing will ever pay out.
//
// Both were observed on one wallet in one read, 2026-08-22:
//
//     market    leg   indexer    chain
//     …5d4e     UP     0.3100   0.0000   ← stale high, reported every cycle
//     …5dc1     DOWN   0.7900   0.0000   ← stale high
//     …5dc2     DOWN   0.0700   0.0700
//     …5deb     DOWN   0.3800   0.3800
//     …5de8     DOWN   0.3100   0.3100
//
// Two of five wrong, and the two wrong ones were exactly the holdings the
// runtime kept reporting as "unclaimed payouts" on every pass. There were no
// unclaimed payouts. There were no tokens.
//
// So this module reads the balance the pool's own outcome-token contract
// reports. Outcome positions are ids on a shared ERC-6909 singleton, which the
// pool names along with the ids for its two legs, so one `getBinaryPoolParams`
// (cached — a pool's ids do not change within its generation) plus one
// `balanceOf(owner, id)` settles the question.
//
// A failed read returns null and NEVER a zero. The difference matters more than
// anything else here: a zero from this module authorises deleting a position,
// so an RPC hiccup that returned zero instead of null would quietly erase a
// portfolio. Callers keep the indexer's figure when they get null, which is no
// worse than before.

import { timeoutSignal } from "../core/timeout.js";

/** `getBinaryPoolParams()` */
const POOL_PARAMS_SELECTOR = "0x9b98cc19";
/** ERC-6909 `balanceOf(address,uint256)` */
const BALANCE_OF_SELECTOR = "0x00fdd58e";

export interface PoolOutcomeIds {
  /** The ERC-6909 singleton the outcome positions live on. */
  outcomeToken: `0x${string}`;
  yesId: bigint;
  noId: bigint;
  /** Raw units per whole share, straight from the pool rather than assumed. */
  oneCollateral: bigint;
}

const word = (hex: string): string => hex.replace(/^0x/, "").padStart(64, "0").toLowerCase();
const addressArg = (a: string): string => word(a.toLowerCase().replace(/^0x/, ""));
const at = (data: string, index: number): string => data.slice(2 + index * 64, 2 + (index + 1) * 64);

/**
 * Read-only chain access for outcome balances.
 *
 * Deliberately dependency-free JSON-RPC rather than a contract library: this is
 * on the path of every reconciliation, including in a process that has no
 * signer, no kit and no wallet library loaded.
 */
export class OutcomeReader {
  private readonly params = new Map<string, PoolOutcomeIds | null>();
  /** Reads that failed, so a dead RPC is not re-asked every cycle for every leg. */
  private failures = 0;

  constructor(
    private readonly rpcUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call(to: string, data: string): Promise<string | null> {
    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal: timeoutSignal(this.timeoutMs),
      });
      const body = (await res.json()) as { result?: string; error?: unknown };
      if (typeof body.result !== "string" || body.result.length < 66) {
        this.failures++;
        return null;
      }
      this.failures = 0;
      return body.result;
    } catch {
      this.failures++;
      return null;
    }
  }

  /**
   * The outcome-token contract and leg ids for a pool.
   *
   * Cached including the negative case: a pool that cannot answer this will not
   * start answering it mid-run, and retrying it once per leg per cycle turns one
   * broken market into a stall.
   */
  async idsFor(pool: string): Promise<PoolOutcomeIds | null> {
    const key = pool.toLowerCase();
    const cached = this.params.get(key);
    if (cached !== undefined) return cached;

    const raw = await this.call(pool, POOL_PARAMS_SELECTOR);
    // A single failure is not cached — that would turn a momentary RPC blip into
    // a market this process refuses to verify for the rest of its life.
    if (!raw) return null;

    try {
      // The struct is returned inline: collateralToken, market, outcomeToken,
      // yesId, noId, oneCollateral, …
      const ids: PoolOutcomeIds = {
        outcomeToken: `0x${at(raw, 2).slice(24)}`,
        yesId: BigInt(`0x${at(raw, 3)}`),
        noId: BigInt(`0x${at(raw, 4)}`),
        oneCollateral: BigInt(`0x${at(raw, 5)}`),
      };
      if (!/^0x[0-9a-f]{40}$/.test(ids.outcomeToken) || ids.oneCollateral <= 0n) {
        this.params.set(key, null);
        return null;
      }
      this.params.set(key, ids);
      return ids;
    } catch {
      this.params.set(key, null);
      return null;
    }
  }

  /**
   * What `owner` actually holds of one leg, in whole shares.
   *
   * `null` means "could not be established" and must never be treated as zero.
   */
  async balance(pool: string, owner: string, leg: "UP" | "DOWN"): Promise<number | null> {
    const ids = await this.idsFor(pool);
    if (!ids) return null;
    const id = leg === "UP" ? ids.yesId : ids.noId;
    const data = BALANCE_OF_SELECTOR + addressArg(owner) + word(id.toString(16));
    const raw = await this.call(ids.outcomeToken, data);
    if (!raw) return null;
    try {
      return Number(BigInt(raw.slice(0, 66))) / Number(ids.oneCollateral);
    } catch {
      return null;
    }
  }

  /** Whether the last few reads all failed — the signal to stop trusting this pass. */
  get degraded(): boolean {
    return this.failures >= 3;
  }
}
