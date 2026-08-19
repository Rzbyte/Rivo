// Read-only GraphQL access to the Somnia Markets indexer and the oracle price
// feed. No signer, no SDK, no key — every number Rivo publishes is reproducible
// from these calls alone.

import { endpoints, feedId, network, type Asset, type Network } from "./config.js";
import type { RestingOrder } from "../engine/book.js";

export class IndexerError extends Error {
  constructor(op: string, detail: string) {
    super(`indexer ${op}: ${detail}`);
    this.name = "IndexerError";
  }
}

async function gql<T>(url: string, op: string, query: string, variables?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  if (!res.ok) throw new IndexerError(op, `HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new IndexerError(op, body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new IndexerError(op, "no data in response");
  return body.data;
}

/** One executed trade. `price` is an Up probability. */
export interface FillRow {
  at: number;
  /** Up probability, whichever leg the taker was on. */
  price: number;
  size: number;
  maker: string;
  taker: string;
  /**
   * Which side the RESTING order was on — `BUY_YES` or `SELL_YES`.
   *
   * This is what makes a maker backtest possible rather than hypothetical. It
   * says which of a maker's two quotes was the one that got hit, so Rivo can be
   * credited with a fill only on the side it would actually have been resting on.
   */
  makerSide: string;
}

/** A binary Event Contract window, as the indexer reports it. */
export interface MarketRow {
  marketId: string;
  asset: Asset;
  /** Series cadence in seconds: 900 = 15m, 3600 = 1h, 14400 = 4h, 86400 = 1d. */
  intervalSec: number;
  /** Unix seconds. */
  tradingStart: number;
  expiry: number;
  /** `clobStatus` — NOTE: the indexer lags the chain and reports windows as
   *  `Trading` after they have locked. Gate live actions on-chain, never here. */
  status: string;
  /** 0 on every up/down market: the question is "closes at or above its OPENING price". */
  strike: string | null;
  /** 0 = UP won, 1 = DOWN won, null = unresolved. */
  winningOutcome: number | null;
  finalized: boolean;
  voided: boolean;
  tradeCount: number;
}

const MARKET_FIELDS = `
  marketId asset intervalSec tradingStart expiry
  clobStatus strike winningOutcome finalized voided tradeCount
`;

function toRow(r: Record<string, unknown>): MarketRow {
  return {
    marketId: String(r.marketId),
    asset: String(r.asset) as Asset,
    intervalSec: Number(r.intervalSec ?? 0),
    tradingStart: Number(r.tradingStart ?? 0),
    expiry: Number(r.expiry ?? 0),
    status: String(r.clobStatus ?? ""),
    strike: r.strike === null || r.strike === undefined ? null : String(r.strike),
    winningOutcome: r.winningOutcome === null || r.winningOutcome === undefined ? null : Number(r.winningOutcome),
    finalized: Boolean(r.finalized),
    voided: Boolean(r.voided),
    tradeCount: Number(r.tradeCount ?? 0),
  };
}

export class Indexer {
  private readonly url: string;
  private readonly feed: string;
  readonly venueId: string;
  /**
   * Collateral decimals — 6 on testnet (tUSDC), 18 on mainnet (USDso).
   *
   * Not cosmetic: order prices and sizes come off the indexer in raw units, so
   * assuming the wrong one misreads every book by a factor of 10^12.
   */
  readonly decimals: number;

  constructor(net?: Network) {
    const n = net ?? network();
    const ep = endpoints(n);
    this.url = ep.indexer;
    this.feed = ep.priceFeed;
    this.venueId = ep.venueId;
    this.decimals = Number(process.env.DECIMALS ?? (n === "mainnet" ? 18 : 6));
  }

  private get one(): number {
    return 10 ** this.decimals;
  }

  /** Resting orders on the given markets, keyed by lowercase marketId. */
  async restingOrders(marketIds: string[]): Promise<Map<string, RestingOrder[]>> {
    const out = new Map<string, RestingOrder[]>();
    const ids = marketIds.map((m) => m.toLowerCase());
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const data = await gql<{ Order: { market_id: string; price: string; quantityRemaining: string; side: string }[] }>(
        this.url,
        "restingOrders",
        `query($ids:[String!]){
           Order(where:{ status:{_eq:"Open"}, market_id:{_in:$ids} }, limit:1000){
             market_id price quantityRemaining side
           }
         }`,
        { ids: chunk },
      );
      for (const o of data.Order) {
        const key = o.market_id.toLowerCase();
        const list = out.get(key) ?? [];
        list.push({
          side: String(o.side),
          price: Number(o.price) / this.one,
          size: Number(o.quantityRemaining) / this.one,
        });
        out.set(key, list);
      }
    }
    return out;
  }

  /** Most recent underlying price, with its age. `mark` is the oracle's EMA. */
  async latestSpot(asset: Asset): Promise<{ spot: number; mark: number; at: number }> {
    if (!this.feed) throw new IndexerError("latestSpot", "no price-feed endpoint for this network");
    const data = await gql<{ PricePoint: { spot: string; mark: string; blockTimestamp: string }[] }>(
      this.feed,
      "latestSpot",
      `query($f:String!){
         PricePoint(where:{ feed_id:{_eq:$f} }, order_by:{ blockTimestamp: desc }, limit:1){
           spot mark blockTimestamp
         }
       }`,
      { f: feedId(asset) },
    );
    const row = data.PricePoint[0];
    if (!row) throw new IndexerError("latestSpot", `no price points for ${asset}`);
    return { spot: Number(row.spot) / 1e18, mark: Number(row.mark) / 1e18, at: Number(row.blockTimestamp) };
  }

  /**
   * Settled binary windows, oldest first, paged past Hasura's row cap.
   *
   * Scoped to the venue: several operators list markets side by side on one
   * deployment, and mixing them would calibrate against questions Rivo never trades.
   */
  async settledMarkets(opts: { limit?: number; sinceExpiry?: number } = {}): Promise<MarketRow[]> {
    const want = opts.limit ?? 20_000;
    const page = 1000;
    const out: MarketRow[] = [];
    for (let offset = 0; out.length < want; offset += page) {
      const data = await gql<{ Market: Record<string, unknown>[] }>(
        this.url,
        "settledMarkets",
        `query($v:String!,$since:numeric!,$limit:Int!,$offset:Int!){
           Market(
             where:{ marketType:{_eq:"BINARY"}, venueId:{_eq:$v},
                     finalized:{_eq:true}, expiry:{_gt:$since} }
             order_by:{ expiry: asc }, limit:$limit, offset:$offset
           ){ ${MARKET_FIELDS} }
         }`,
        { v: this.venueId, since: opts.sinceExpiry ?? 0, limit: Math.min(page, want - out.length), offset },
      );
      const rows = data.Market.map(toRow);
      out.push(...rows);
      if (rows.length < page) break;
    }
    return out;
  }

  /**
   * Windows the indexer believes are open. Confirm on-chain before acting.
   *
   * The expiry bound is applied SERVER-side on purpose. `clobStatus` alone is
   * not a live filter: the indexer leaves long-settled windows flagged
   * `Trading` — measured 2026-08-19, it reported ~20 as Trading when only 8 were
   * genuinely open. Fetching by status and trimming locally silently returns
   * nothing as soon as the stale rows outnumber the page size.
   */
  async liveMarkets(): Promise<MarketRow[]> {
    const now = Math.floor(Date.now() / 1000);
    const data = await gql<{ Market: Record<string, unknown>[] }>(
      this.url,
      "liveMarkets",
      `query($v:String!,$now:numeric!){
         Market(where:{ marketType:{_eq:"BINARY"}, venueId:{_eq:$v},
                        clobStatus:{_eq:"Trading"}, expiry:{_gt:$now} }
                order_by:{ expiry: asc }, limit:100){ ${MARKET_FIELDS} }
       }`,
      { v: this.venueId, now },
    );
    return data.Market.map(toRow);
  }

  /**
   * The settlement reference for each market — the price its question compares
   * against. Up/down windows carry `strike = 0` and settle against their own
   * OPENING price, which lives on a separate oracle question.
   *
   * Returned in whatever units the oracle used; call `scaleReference` to fix them.
   */
  async openingReferences(marketIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ids = marketIds.map((m) => m.toLowerCase());
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const links = await gql<{ MarketReferenceLink: { market: string; referenceQuestionId: string }[] }>(
        this.url,
        "openingRefs",
        `query($ids:[String!]){ MarketReferenceLink(where:{market_id:{_in:$ids}}){ market: market_id referenceQuestionId } }`,
        { ids: chunk },
      );
      const byMarket = new Map(links.MarketReferenceLink.map((l) => [l.market.toLowerCase(), String(l.referenceQuestionId)]));
      const qids = [...new Set(byMarket.values())];
      if (qids.length === 0) continue;
      const answers = await gql<{ OracleAnswer: { id: string; numericValue: string | null }[] }>(
        this.url,
        "openingAnswers",
        `query($q:[String!]){ OracleAnswer(where:{id:{_in:$q}}){ id numericValue } }`,
        { q: qids },
      );
      const byQid = new Map(answers.OracleAnswer.map((a) => [String(a.id), a.numericValue]));
      for (const [market, qid] of byMarket) {
        const raw = byQid.get(qid);
        if (raw === null || raw === undefined) continue;
        out.set(market, Number(raw));
      }
    }
    return out;
  }

  /**
   * Executed fills on the given markets, ascending by time.
   *
   * These are the backtest's ground truth for liquidity. A synthetic book built
   * from candles would let a strategy fill any size at any price it liked; a
   * fill that actually happened is proof that a counterparty existed at that
   * price, at that moment, for at least that size.
   *
   * `fillPrice` is an Up probability, whichever leg the taker was on.
   */
  async fills(marketIds: string[]): Promise<Map<string, FillRow[]>> {
    const out = new Map<string, FillRow[]>();
    const ids = marketIds.map((m) => m.toLowerCase());
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      for (let offset = 0; ; offset += 1000) {
        const data = await gql<{ Fill: Record<string, unknown>[] }>(
          this.url,
          "fills",
          `query($ids:[String!],$offset:Int!){
             Fill(where:{ market_id:{_in:$ids} }, order_by:{ timestamp: asc }, limit:1000, offset:$offset){
               market_id timestamp fillPrice quantity maker taker makerSide
             }
           }`,
          { ids: chunk, offset },
        );
        for (const f of data.Fill) {
          const key = String(f.market_id).toLowerCase();
          const list = out.get(key) ?? [];
          list.push({
            at: Number(f.timestamp),
            price: Number(f.fillPrice) / this.one,
            size: Number(f.quantity) / this.one,
            maker: String(f.maker ?? ""),
            taker: String(f.taker ?? ""),
            makerSide: String(f.makerSide ?? ""),
          });
          out.set(key, list);
        }
        if (data.Fill.length < 1000) break;
      }
    }
    for (const list of out.values()) list.sort((a, b) => a.at - b.at);
    return out;
  }

  /**
   * What an account actually holds, straight from the chain's own accounting.
   *
   * This is the only reading of a portfolio that does not depend on Rivo having
   * correctly remembered what it did. A bot that trusts its own notes will, the
   * first time it dies between a fill landing and its state being written,
   * believe it holds nothing and buy a second copy of everything.
   *
   * Keyed `marketId:LEG` in human units. `outcomeIndex` is 0 for Up, 1 for Down.
   */
  async outcomeBalances(account: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!account) return out;
    for (let offset = 0; ; offset += 500) {
      const data = await gql<{ OutcomeBalance: { market_id: string; outcomeIndex: number; balance: string }[] }>(
        this.url,
        "outcomeBalances",
        `query($acct:String!,$offset:Int!){
           OutcomeBalance(where:{ account:{_eq:$acct}, balance:{_gt:"0"} }, limit:500, offset:$offset){
             market_id outcomeIndex balance
           }
         }`,
        { acct: account.toLowerCase(), offset },
      );
      for (const b of data.OutcomeBalance) {
        const leg = Number(b.outcomeIndex) === 0 ? "UP" : "DOWN";
        const key = `${b.market_id.toLowerCase()}:${leg}`;
        out.set(key, (out.get(key) ?? 0) + Number(b.balance) / this.one);
      }
      if (data.OutcomeBalance.length < 500) break;
    }
    return out;
  }

  /**
   * Settlement status for specific windows.
   *
   * A settled window drops out of the live list, so a bot holding a position in
   * one cannot find it again by scanning what is active — this is the read that
   * closes the loop. Voided windows are reported too: both legs redeem at 0.5
   * there, which is neither a win nor a loss and must not be scored as either.
   */
  async outcomes(marketIds: string[]): Promise<Map<string, { finalized: boolean; voided: boolean; winningOutcome: number | null; expiry: number }>> {
    const out = new Map<string, { finalized: boolean; voided: boolean; winningOutcome: number | null; expiry: number }>();
    const ids = marketIds.map((m) => m.toLowerCase());
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const data = await gql<{ Market: Record<string, unknown>[] }>(
        this.url,
        "outcomes",
        `query($ids:[String!]){
           Market(where:{ marketId:{_in:$ids} }, limit:200){
             marketId finalized voided winningOutcome expiry
           }
         }`,
        { ids: chunk },
      );
      for (const m of data.Market) {
        out.set(String(m.marketId).toLowerCase(), {
          finalized: Boolean(m.finalized),
          voided: Boolean(m.voided),
          winningOutcome: m.winningOutcome === null || m.winningOutcome === undefined ? null : Number(m.winningOutcome),
          expiry: Number(m.expiry ?? 0),
        });
      }
    }
    return out;
  }

  /** M1 candles for one underlying, ascending, paged. `close` is 1e18-scaled. */
  async candles(asset: Asset, fromSec: number, toSec: number): Promise<{ t: number; close: number }[]> {
    if (!this.feed) throw new IndexerError("candles", "no price-feed endpoint for this network (set RIVO_PRICE_FEED_URL)");
    const out: { t: number; close: number }[] = [];
    let cursor = fromSec;
    for (;;) {
      const data = await gql<{ Candle: { bucketStart: string; close: string }[] }>(
        this.feed,
        "candles",
        `query($f:String!,$from:numeric!,$to:numeric!){
           Candle(where:{ feed_id:{_eq:$f}, resolution:{_eq:"M1"},
                          bucketStart:{_gt:$from, _lte:$to} }
                  order_by:{ bucketStart: asc }, limit:1000){ bucketStart close }
         }`,
        { f: feedId(asset), from: cursor, to: toSec },
      );
      if (data.Candle.length === 0) break;
      for (const c of data.Candle) out.push({ t: Number(c.bucketStart), close: Number(c.close) / 1e18 });
      const last = out[out.length - 1];
      if (!last || data.Candle.length < 1000) break;
      cursor = last.t;
    }
    return out;
  }
}

/**
 * Put an oracle `numericValue` back into real price units.
 *
 * The scale is NOT declared anywhere on the row, and it is not constant: opening
 * references are 1e2 while settlement answers are 1e4 (measured on testnet,
 * 2026-08-19). Reading a reference at the wrong scale is silent and catastrophic
 * — it moves the price by 100x, which turns every probability into 0 or 1 while
 * still looking like a plausible number.
 *
 * So we do not trust a constant. We pick the power of ten that lands the
 * reference nearest to a known-good price for the same asset, and reject the
 * market when nothing lands close.
 */
export function scaleReference(raw: number, referencePrice: number): number | null {
  if (!(raw > 0) || !(referencePrice > 0)) return null;
  let best: { value: number; err: number } | null = null;
  for (let k = 0; k <= 8; k++) {
    const value = raw / 10 ** k;
    const err = Math.abs(Math.log(value / referencePrice));
    if (!best || err < best.err) best = { value, err };
  }
  // A window's opening price sits within a few percent of prices during its
  // life. Anything beyond ~40% away means no scale fits and the row is unusable.
  if (!best || best.err > 0.35) return null;
  return best.value;
}
