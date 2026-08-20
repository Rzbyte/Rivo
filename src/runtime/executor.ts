// The seam between a decision and the chain.
//
// Two implementations behind one interface. `DryExecutor` fills against the book
// snapshot the allocator already read, which makes the whole runtime testable
// with no key, no gas and no counterparty. `LiveExecutor` routes the same calls
// through `@dreamdex-bot-kit/ec-core`, which owns every sharp edge worth not
// re-learning: tick and lot quantisation in integer space, mandatory order
// expiry, the fact that a reverted write does not throw, and pre-flight wallet
// checks so an underfunded order fails locally instead of burning gas.
//
// DRY RUN IS THE DEFAULT, matching every strategy in the kit. Trading requires
// saying so explicitly.

import type { Leg, MarketBook } from "../engine/book.js";
import { simulateBuy } from "../engine/book.js";
import { loadEcCore, type EcContext, type EcCore, type MarketOnchain, type UnifiedMarket } from "./ec-core-types.js";
import { loadEnv } from "../core/env.js";
import { AllowanceManager } from "./allowance.js";
import { COLLATERAL_TOKEN, network } from "../core/config.js";

export interface OrderRequest {
  marketId: string;
  leg: Leg;
  /** Shares. */
  size: number;
  /** Worst price acceptable, in this leg's own probability terms. */
  limitPrice: number;
}

export interface OrderResult {
  filled: number;
  avgPrice: number;
  cost: number;
  txHash?: string;
  /** Set when nothing happened and why. */
  rejected?: string;
}

export interface Executor {
  readonly mode: "dry" | "live";
  buy(req: OrderRequest, book: MarketBook | undefined): Promise<OrderResult>;
  sell(req: OrderRequest, book: MarketBook | undefined): Promise<OrderResult>;
  /** 1 collateral -> 1 Up + 1 Down. Backs sell-side inventory. */
  mintSet(marketId: string, amount: number): Promise<OrderResult>;
  /** 1 Up + 1 Down -> 1 collateral. Recovers capital trapped in offsetting legs. */
  mergeSet(marketId: string, amount: number): Promise<OrderResult>;
  /** Sweep settled windows and redeem. Returns collateral recovered. */
  claim(): Promise<number>;
  /** Confirm on-chain that a window still accepts orders. */
  isTradable(marketId: string): Promise<boolean>;
  /**
   * Drop any cached on-chain state. Called once at the top of every cycle.
   *
   * Pools are recycled across successive windows, so a snapshot is valid for one
   * pass and no longer. Holding one across cycles means eventually acting on the
   * pool a market USED to live in.
   */
  newCycle(): void;
  /**
   * The wallet whose holdings this executor's state should mirror, or null.
   *
   * Null in a dry run, and that is the whole signal reconciliation needs:
   * simulated positions have no on-chain counterpart, so checking them against a
   * chain that has never heard of them would delete the entire portfolio.
   */
  address(): Promise<string | null>;
}

/**
 * Paper execution against the snapshot the allocator already priced.
 *
 * Deliberately pessimistic in one specific way: it walks the real depth ladder
 * rather than assuming the top level is infinite, so a size the book cannot
 * supply comes back partially filled here exactly as it would live. A dry run
 * that always fills in full teaches the allocator nothing.
 */
export class DryExecutor implements Executor {
  readonly mode = "dry" as const;

  async buy(req: OrderRequest, book: MarketBook | undefined): Promise<OrderResult> {
    if (!book) return { filled: 0, avgPrice: 0, cost: 0, rejected: "no book snapshot" };
    const fill = simulateBuy(book[req.leg], req.size, req.limitPrice);
    if (fill.size <= 0) return { filled: 0, avgPrice: 0, cost: 0, rejected: "no depth at limit" };
    return { filled: fill.size, avgPrice: fill.avgPrice, cost: fill.cost };
  }

  async sell(req: OrderRequest, book: MarketBook | undefined): Promise<OrderResult> {
    if (!book) return { filled: 0, avgPrice: 0, cost: 0, rejected: "no book snapshot" };
    // Selling crosses the bid side: walk it descending while it clears our limit.
    let remaining = req.size;
    let proceeds = 0;
    let filled = 0;
    for (const level of book[req.leg].bids) {
      if (remaining <= 0 || level.price < req.limitPrice) break;
      const take = Math.min(remaining, level.size);
      proceeds += take * level.price;
      filled += take;
      remaining -= take;
    }
    if (filled <= 0) return { filled: 0, avgPrice: 0, cost: 0, rejected: "no bid at limit" };
    return { filled, avgPrice: proceeds / filled, cost: -proceeds };
  }

  async mintSet(_marketId: string, amount: number): Promise<OrderResult> {
    return { filled: amount, avgPrice: 1, cost: amount };
  }

  async mergeSet(_marketId: string, amount: number): Promise<OrderResult> {
    return { filled: amount, avgPrice: 1, cost: -amount };
  }

  async claim(): Promise<number> {
    // Settlement in a dry run is resolved from the indexer by the loop itself,
    // which knows each window's winning outcome. There is nothing to sweep.
    return 0;
  }

  async isTradable(): Promise<boolean> {
    return true;
  }

  async address(): Promise<string | null> {
    return null; // nothing simulated exists on-chain to reconcile against
  }

  newCycle(): void {
    // Nothing cached in a dry run.
  }
}

/**
 * Live execution through `ec-core`.
 *
 * Loaded lazily so that the entire read-only surface of Rivo — calibration,
 * scanning, allocation, backtests — runs without the SDK, a signer, or an RPC
 * endpoint being reachable.
 *
 * NOTE: this path has not been exercised against the chain in this build; it
 * needs a funded testnet key. It is written against `ec-core`'s documented
 * surface rather than stubbed, so it is one credential away from running, but
 * it should be canaried at minimum size before it is trusted.
 */
/**
 * Lot granularity actually accepted by the venue, in steps per share.
 *
 * 100 = a hundredth of a share. Deliberately coarser than the tick the config
 * claims, because the config's claim is what reverts. Override if a venue
 * tightens or loosens.
 */
const LOT_STEPS_PER_SHARE = Number(process.env.RIVO_LOT_STEPS ?? 100);

export class LiveExecutor implements Executor {
  readonly mode = "live" as const;
  /** Collateral decimals — 6 on testnet, 18 on mainnet. */
  decimals?: number;
  /** Called once per pool when an approval transaction is sent. */
  onApprove?: (pool: string, hash: string) => void;
  /** Called for anything worth an operator's attention that is not an error. */
  onNote?: (message: string) => void;
  private ctx: EcContext;
  private core: EcCore | null = null;
  private readonly marketCache = new Map<string, { market: UnifiedMarket; onchain: MarketOnchain }>();
  private allowances: AllowanceManager | null = null;

  private async load(): Promise<EcCore> {
    if (!this.core) {
      this.core = await loadEcCore();
      this.ctx = this.core.createExchange({ withSigner: true });
    }
    return this.core;
  }

  /**
   * Resolve a market to the ONE on-chain generation this cycle acts on.
   *
   * Pools are recycled across successive windows, so a snapshot must be taken
   * once and reused for every read and write in a pass. Re-resolving mid-decision
   * is how a bot ends up straddling a roll and sending an order to the pool that
   * used to be this market.
   */
  private async resolve(marketId: string): Promise<{ market: UnifiedMarket; onchain: MarketOnchain } | null> {
    const core = await this.load();
    const cached = this.marketCache.get(marketId);
    if (cached) return cached;
    const markets = await core.activeMarkets(this.ctx, { max: 100 });
    const market = markets.find((m) => String(m.info?.marketId ?? "").toLowerCase() === marketId.toLowerCase());
    if (!market) return null;
    const onchain = await core.marketOnchain(this.ctx, market);
    if (!onchain) return null;
    const entry = { market, onchain };
    this.marketCache.set(marketId, entry);
    return entry;
  }

  /** Drop cached generations. Call once per cycle, before anything is read. */
  newCycle(): void {
    this.marketCache.clear();
  }

  /**
   * Lazily build the allowance manager. Needs the same key the exchange uses.
   */
  private allowanceManager(): AllowanceManager | null {
    if (this.allowances) return this.allowances;
    loadEnv();
    const pk = (process.env.PRIVATE_KEY ?? "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
    const net = network();
    this.allowances = new AllowanceManager({
      rpcUrl:
        process.env.RPC_URL ??
        (net === "mainnet" ? "https://api.infra.mainnet.somnia.network" : "https://api.infra.testnet.somnia.network"),
      chainId: net === "mainnet" ? 5031 : 50312,
      privateKey: pk,
      token: (process.env.COLLATERAL_TOKEN ?? COLLATERAL_TOKEN[net]) as `0x${string}`,
    });
    return this.allowances;
  }

  private async place(req: OrderRequest, side: "buy" | "sell"): Promise<OrderResult> {
    const core = await this.load();
    const resolved = await this.resolve(req.marketId);
    if (!resolved) return { filled: 0, avgPrice: 0, cost: 0, rejected: "market not live" };
    const { market, onchain } = resolved;
    if (!core.isTradable(onchain)) {
      return { filled: 0, avgPrice: 0, cost: 0, rejected: "window not in Trading" };
    }

    // The pool escrows the collateral, so it has to be allowed to pull it.
    // Neither ec-core nor the SDK does this for event contracts — the spot path
    // does, and its absence here is why a fresh wallet gets
    // `placeBinaryOrder reverted: for an unknown reason`, which names nothing.
    if (side === "buy" && onchain.pool) {
      // CHECK ONLY — never approve from inside the loop.
      //
      // Approving is a transaction. The SDK signs with its own locally-tracked
      // nonce, so a second signer touching the same key races it. Measured: an
      // inline approval made every order in that cycle revert with
      // `placeBinaryOrder reverted: for an unknown reason`, while the identical
      // order with no approval alongside it filled immediately. The kit warns
      // about exactly this for its claim sweep — two senders on one key race
      // each other's nonce.
      const mgr = this.allowanceManager();
      if (mgr) {
        try {
          const one = 10 ** (this.decimals ?? 6);
          const need = BigInt(Math.max(1, Math.ceil(req.size * req.limitPrice * one)));
          const current = await mgr.allowanceFor(onchain.pool);
          if (current < need) {
            return {
              filled: 0,
              avgPrice: 0,
              cost: 0,
              rejected:
                `pool ${onchain.pool.slice(0, 10)}… may only pull ${current} of the ${need} needed. ` +
                `Stop Rivo and run \`npm run approve\` — approving here would race the SDK's nonce.`,
            };
          }
        } catch {
          // A failed allowance read should not block a trade that might work;
          // the order itself is the authority and will revert if it cannot pay.
        }
      }
    }

    // Selling escrows the token being sold — a naked short is impossible here —
    // so ask what is actually sellable rather than assuming the requested size.
    let size = req.size;
    if (side === "sell") {
      size = await core.sellableSize(this.ctx, onchain, req.leg === "UP" ? "YES" : "NO", req.size);
      if (size <= 0) return { filled: 0, avgPrice: 0, cost: 0, rejected: "no inventory to sell" };
    }
    const outcome = req.leg === "UP" ? "YES" : "NO";
    const price = core.clampProbability(req.limitPrice);

    // Snap the size to a coarse lot before sending.
    //
    // ec-core configures testnet `lot: 1` raw unit — "measured — the venue
    // accepted orders down to 1 raw unit" — but that is not what the venue does
    // now. Measured 2026-08-20 on one market at one price: sizes of 1, 2, 3, 5
    // and 8 all filled, 3.71 filled, and 9.749193184999303 reverted with
    // `placeBinaryOrder reverted: for an unknown reason`. The common factor is
    // raw units: 3.71 is exactly 3,710,000 while 9.749193… floors to 9,749,193,
    // which is a multiple of nothing.
    //
    // Fractional-Kelly sizing produces the latter constantly, so this is not an
    // edge case for Rivo — it is every order. Rounding DOWN to a hundredth of a
    // share keeps the size inside what the allocator authorised.
    size = Math.floor(size * LOT_STEPS_PER_SHARE) / LOT_STEPS_PER_SHARE;
    if (size <= 0) return { filled: 0, avgPrice: 0, cost: 0, rejected: "size rounds to zero at the venue's lot" };
    try {
      const res = await core.placeLimit(this.ctx, {
      market,
      onchain,
      outcome,
      side,
      price,
      size,
      // IOC: take what crosses now and cancel the rest. An unfilled remainder
      // that rests holds escrow invisibly unless every open order is tracked,
      // and the allocator has already decided what this cycle should own.
      type: "ioc",
    });
      const cost = side === "buy" ? res.filled * res.price : -(res.filled * res.price);
      return { filled: res.filled, avgPrice: res.price, cost, txHash: res.hash };
    } catch (e) {
      // An error that does not say what it was trying to do is most of a wasted
      // afternoon. The SDK's message is `placeBinaryOrder reverted: for an
      // unknown reason` and names nothing — not the market, not the side, not
      // the price. Attach it here so a log line is actionable on its own.
      const detail =
        `${side} ${outcome} ${size} @ ${price} on pool ${String(onchain.pool ?? "?").slice(0, 10)}… ` +
        `(market ${req.marketId.slice(-10)})`;
      throw new Error(`${e instanceof Error ? e.message : String(e)} — while placing ${detail}`);
    }
  }

  buy(req: OrderRequest): Promise<OrderResult> {
    return this.place(req, "buy");
  }

  sell(req: OrderRequest): Promise<OrderResult> {
    return this.place(req, "sell");
  }

  async mintSet(marketId: string, amount: number): Promise<OrderResult> {
    const core = await this.load();
    const resolved = await this.resolve(marketId);
    if (!resolved) return { filled: 0, avgPrice: 0, cost: 0, rejected: "market not live" };
    await core.seedInventory(this.ctx, resolved.market, resolved.onchain);
    return { filled: amount, avgPrice: 1, cost: amount };
  }

  async mergeSet(marketId: string, amount: number): Promise<OrderResult> {
    // Merging is `mergeCompleteSet` on the exchange tier. It is the one exit that
    // needs no counterparty — but it needs BOTH legs in equal size, so it can
    // only ever recover capital already trapped in offsetting inventory. It
    // cannot close a directional position; selling the held leg does that.
    await this.load();
    const ex = (this.ctx as { exchange?: { burnSet?: (s: string, n: number) => Promise<unknown> } }).exchange;
    if (!ex?.burnSet) return { filled: 0, avgPrice: 0, cost: 0, rejected: "burnSet unavailable on this SDK build" };
    const resolved = await this.resolve(marketId);
    if (!resolved) return { filled: 0, avgPrice: 0, cost: 0, rejected: "market not live" };
    const symbol = resolved.market.symbol;
    if (!symbol) return { filled: 0, avgPrice: 0, cost: 0, rejected: "no symbol for market" };
    await ex.burnSet(symbol, amount);
    return { filled: amount, avgPrice: 1, cost: -amount };
  }

  async claim(): Promise<number> {
    const core = await this.load();
    // Winnings are claimed, not received: a settled window pays out only when
    // asked. Claiming signs from the same key that trades, so it runs inline
    // rather than on a timer — two senders on one key race each other's nonce.
    await core.maybeClaim(this.ctx);
    return 0; // ec-core reports via its own logging; the loop reconciles from state
  }

  async isTradable(marketId: string): Promise<boolean> {
    const core = await this.load();
    const resolved = await this.resolve(marketId);
    return resolved ? core.isTradable(resolved.onchain) : false;
  }

  async address(): Promise<string | null> {
    await this.load();
    // `ctx.exchange.walletAddress` is the property ec-core's own `sellableSize`
    // and `netPosition` read to identify the signer, so it is the right one —
    // but like the rest of this class it has not been exercised against a live
    // signer. If reconciliation reports nothing on a funded wallet, check here first.
    const ex = (this.ctx as { exchange?: { walletAddress?: string } }).exchange;
    return ex?.walletAddress ?? null;
  }
}

/** Pick an executor. Live requires BOTH a key and an explicit opt-out of dry run. */
export function makeExecutor(dryRun: boolean): Executor {
  loadEnv();
  const hasKey = Boolean((process.env.PRIVATE_KEY ?? "").trim().match(/^0x[0-9a-fA-F]{64}$/));
  if (dryRun || !hasKey) return new DryExecutor();
  return new LiveExecutor();
}

/** Whether a usable signer is configured. `0x...` placeholders do not count. */
export function hasSigner(): boolean {
  loadEnv();
  return Boolean((process.env.PRIVATE_KEY ?? "").trim().match(/^0x[0-9a-fA-F]{64}$/));
}
