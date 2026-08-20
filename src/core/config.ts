// Endpoints and venue constants for the DreamDEX Event Contract venue.
//
// These mirror `@dreamdex-bot-kit/ec-core`'s config, but the calibration
// harness deliberately depends on nothing but public HTTP: it must run with no
// private key, no signer, and no SDK, so that anyone reading the submission can
// reproduce every number in it.

import { loadEnv } from "./env.js";

// Every reader of configuration goes through this module, so loading the file
// here means no entry point can forget to do it — which is precisely how live
// mode ended up unreachable from `.env`.
loadEnv();

export type Network = "testnet" | "mainnet";

export interface RivoEndpoints {
  /** Somnia Markets indexer — binary markets, orders, fills, oracle answers. */
  indexer: string;
  /** Oracle price-feed indexer — the UNDERLYING BTC/ETH spot, not the contract's own price. */
  priceFeed: string;
  /** The DreamDEX venue. Venue ids move; override from env when a bot finds no markets. */
  venueId: string;
}

import { VENUE } from "./venue.js";

// Venue facts live in venue.js, which has no runtime dependencies so the public
// page can bundle them. Re-exported here so existing imports keep working and
// there is exactly one definition of each.
export { ASSETS, COLLATERAL_TOKEN, collateralName, feedId, TRADEABLE_CADENCES, tenorLabel, type Asset } from "./venue.js";

export function endpoints(net: Network = network()): RivoEndpoints {
  const base = VENUE[net];
  return {
    indexer: process.env.RIVO_INDEXER_URL || base.indexer,
    priceFeed: process.env.RIVO_PRICE_FEED_URL || base.priceFeed,
    venueId: process.env.VENUE_ID || base.venueId,
  };
}

export function network(): Network {
  const raw = (process.env.NETWORK ?? process.env.DEPLOY_ENV ?? "testnet").toLowerCase();
  return raw === "mainnet" ? "mainnet" : "testnet";
}


