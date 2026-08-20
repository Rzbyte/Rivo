// The public page: what every DreamDEX Event Contract is worth, right now.
//
// No wallet, no key, no install. Both Somnia indexers send permissive CORS
// headers, so this runs entirely in the browser against the same public
// endpoints the runtime uses — which means it can be hosted as static files and
// opened by anyone.
//
// It imports the SAME pricing code the trading runtime uses (`fairValue`,
// `sigmaPerMinute`, `buildBook`, `scaleReference`) rather than a copy. That is
// the point: the number on this page is the number Rivo would trade on, and the
// calibration shown beneath it is the measured accuracy OF THIS FUNCTION over
// thousands of settled windows. A reimplementation would quietly drift and the
// evidence would stop applying to it.

import { fairValue } from "../model/fairvalue.js";
import { sigmaPerMinute, type Bar } from "../model/vol.js";
import { bestAsk, bestBid, buildBook, type MarketBook, type RestingOrder } from "../engine/book.js";
import {
  ASSETS,
  feedId,
  matchesCadence,
  scaleReference,
  tenorLabel,
  TRADEABLE_CADENCES,
  VENUE,
  type Asset,
} from "../core/venue.js";

const NET = "testnet" as const;
const V = VENUE[NET];
/** Minutes of history used to measure realized volatility. */
const VOL_LOOKBACK_MIN = 240;

async function gql<T>(url: string, query: string, variables?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new Error("no data");
  return body.data;
}

export interface Row {
  marketId: string;
  asset: Asset;
  intervalSec: number;
  label: string;
  expiry: number;
  minutesLeft: number;
  reference: number;
  spot: number;
  /** Rivo's probability that this window closes at or above its opening price. */
  fair: number;
  /** What the book charges to buy that outcome, and what it pays to sell it. */
  ask: number | null;
  bid: number | null;
  /** book − model. Positive means the book charges more than Rivo thinks it is worth. */
  gap: number | null;
  book: MarketBook;
}

export interface Snapshot {
  at: number;
  spot: Record<string, number>;
  sigmaPerMin: Record<string, number>;
  rows: Row[];
  /** Windows the venue lists but which cannot be priced yet, and why. */
  unpriced: { label: string; reason: string }[];
}

export async function load(): Promise<Snapshot> {
  const now = Math.floor(Date.now() / 1000);

  // Live windows. The expiry bound is applied server-side on purpose: the
  // indexer leaves long-settled windows flagged `Trading`, and trimming those
  // client-side silently returns nothing once they outnumber the page size.
  const { Market: markets } = await gql<{ Market: RawMarket[] }>(
    V.indexer,
    `query($v:String!,$now:numeric!){
       Market(where:{ marketType:{_eq:"BINARY"}, venueId:{_eq:$v},
                      clobStatus:{_eq:"Trading"}, expiry:{_gt:$now} }
              order_by:{ expiry: asc }, limit:60){
         marketId asset intervalSec tradingStart expiry
       }
     }`,
    { v: V.venueId, now },
  );

  const live = markets.filter((m) => TRADEABLE_CADENCES.some((c) => matchesCadence(Number(m.intervalSec), c)));
  const unpriced: Snapshot["unpriced"] = [];
  if (live.length === 0) return { at: now, spot: {}, sigmaPerMin: {}, rows: [], unpriced };

  const ids = live.map((m) => m.marketId.toLowerCase());

  const [refs, orders, feeds] = await Promise.all([
    openingReferences(ids),
    restingOrders(ids),
    Promise.all(ASSETS.map((a) => underlying(a, now))),
  ]);

  const spot: Record<string, number> = {};
  const sigma: Record<string, number> = {};
  const bars: Record<string, Bar[]> = {};
  ASSETS.forEach((a, i) => {
    const f = feeds[i]!;
    spot[a] = f.spot;
    bars[a] = f.bars;
    sigma[a] = f.sigmaPerMin ?? 0;
  });

  const rows: Row[] = [];
  for (const m of live) {
    const asset = m.asset as Asset;
    const label = `${asset}-${tenorLabel(Number(m.intervalSec))}`;
    const s = spot[asset];
    const sig = sigma[asset];
    if (!s || !sig) {
      unpriced.push({ label, reason: "no price feed for this underlying" });
      continue;
    }
    const raw = refs.get(m.marketId.toLowerCase());
    if (raw === undefined) {
      // Common and benign right after a roll: the opening question has been
      // asked but the oracle has not answered it yet.
      unpriced.push({ label, reason: "opening reference not resolved yet" });
      continue;
    }
    // Anchor the oracle's undeclared decimal scale to spot for this asset.
    const reference = scaleReference(raw, s);
    if (reference === null) {
      unpriced.push({ label, reason: "oracle reference fits no decimal scale near spot" });
      continue;
    }
    const minutesLeft = (Number(m.expiry) - now) / 60;
    const fv = fairValue({ spot: s, reference, sigmaPerMin: sig, tauMinutes: Math.max(minutesLeft, 1 / 60) });
    if (!fv) {
      unpriced.push({ label, reason: "fair value undefined" });
      continue;
    }
    const book = buildBook(orders.get(m.marketId.toLowerCase()) ?? []);
    const ask = bestAsk(book.UP);
    const bid = bestBid(book.UP);
    const mid = ask !== null && bid !== null ? (ask + bid) / 2 : (ask ?? bid);
    rows.push({
      marketId: m.marketId,
      asset,
      intervalSec: Number(m.intervalSec),
      label,
      expiry: Number(m.expiry),
      minutesLeft,
      reference,
      spot: s,
      fair: fv.pUp,
      ask,
      bid,
      gap: mid === null ? null : mid - fv.pUp,
      book,
    });
  }

  rows.sort((a, b) => a.asset.localeCompare(b.asset) || a.intervalSec - b.intervalSec);
  return { at: now, spot, sigmaPerMin: sigma, rows, unpriced };
}

interface RawMarket {
  marketId: string;
  asset: string;
  intervalSec: string;
  tradingStart: string;
  expiry: string;
}

/**
 * The level each window settles against — its own resolved opening price.
 *
 * Every live window carries `strike = 0`, which is not missing data: it means
 * "closes at or above its OPENING price", and that price lives on a separate
 * oracle question reached through MarketReferenceLink.
 */
async function openingReferences(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const links = await gql<{ MarketReferenceLink: { market: string; referenceQuestionId: string }[] }>(
    V.indexer,
    `query($ids:[String!]){ MarketReferenceLink(where:{market_id:{_in:$ids}}){ market: market_id referenceQuestionId } }`,
    { ids },
  );
  const byMarket = new Map(links.MarketReferenceLink.map((l) => [l.market.toLowerCase(), String(l.referenceQuestionId)]));
  const qids = [...new Set(byMarket.values())];
  if (qids.length === 0) return out;
  const answers = await gql<{ OracleAnswer: { id: string; numericValue: string | null }[] }>(
    V.indexer,
    `query($q:[String!]){ OracleAnswer(where:{id:{_in:$q}}){ id numericValue } }`,
    { q: qids },
  );
  const byQid = new Map(answers.OracleAnswer.map((a) => [String(a.id), a.numericValue]));
  for (const [market, qid] of byMarket) {
    const raw = byQid.get(qid);
    if (raw !== null && raw !== undefined) out.set(market, Number(raw));
  }
  return out;
}

async function restingOrders(ids: string[]): Promise<Map<string, RestingOrder[]>> {
  const out = new Map<string, RestingOrder[]>();
  const data = await gql<{ Order: { market_id: string; price: string; quantityRemaining: string; side: string }[] }>(
    V.indexer,
    `query($ids:[String!]){
       Order(where:{ status:{_eq:"Open"}, market_id:{_in:$ids} }, limit:1000){
         market_id price quantityRemaining side
       }
     }`,
    { ids },
  );
  const one = 10 ** V.decimals;
  for (const o of data.Order) {
    const k = o.market_id.toLowerCase();
    const list = out.get(k) ?? [];
    list.push({ side: String(o.side), price: Number(o.price) / one, size: Number(o.quantityRemaining) / one });
    out.set(k, list);
  }
  return out;
}

/** Spot now, plus enough minute bars behind it to measure realized volatility. */
async function underlying(asset: Asset, now: number): Promise<{ spot: number; bars: Bar[]; sigmaPerMin: number | null }> {
  const [p, c] = await Promise.all([
    gql<{ PricePoint: { spot: string }[] }>(
      V.priceFeed,
      `query($f:String!){ PricePoint(where:{feed_id:{_eq:$f}}, order_by:{blockTimestamp:desc}, limit:1){ spot } }`,
      { f: feedId(asset) },
    ),
    gql<{ Candle: { bucketStart: string; close: string }[] }>(
      V.priceFeed,
      `query($f:String!,$from:numeric!){
         Candle(where:{ feed_id:{_eq:$f}, resolution:{_eq:"M1"}, bucketStart:{_gt:$from} }
                order_by:{ bucketStart: asc }, limit:400){ bucketStart close }
       }`,
      { f: feedId(asset), from: now - (VOL_LOOKBACK_MIN + 5) * 60 },
    ),
  ]);
  const spot = p.PricePoint[0] ? Number(p.PricePoint[0].spot) / 1e18 : 0;
  const bars: Bar[] = c.Candle.map((x) => ({ t: Number(x.bucketStart), close: Number(x.close) / 1e18 }));
  return { spot, bars, sigmaPerMin: sigmaPerMinute(bars, bars.length - 1, VOL_LOOKBACK_MIN) };
}
