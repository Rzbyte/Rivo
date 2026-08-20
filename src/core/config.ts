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

const ENDPOINTS: Record<Network, RivoEndpoints> = {
  testnet: {
    indexer: "https://dev.smk.somnia.host/v1/graphql",
    priceFeed: "https://price-feed.dev.oracle.somnia.host/v1/graphql",
    venueId: "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c",
  },
  mainnet: {
    indexer: "https://prd.smk.somnia.host/v1/graphql",
    // No bundled mainnet price feed yet — set RIVO_PRICE_FEED_URL there.
    priceFeed: "",
    venueId: "0x458b30c2d72bfd2c6317304a4594ecbafe5f729d3111b65fdc3a33bd48e5432d",
  },
};

export function endpoints(net: Network = network()): RivoEndpoints {
  const base = ENDPOINTS[net];
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

/** The two underlyings the venue lists. Everything else is derived from these. */
export const ASSETS = ["BTC", "ETH"] as const;
export type Asset = (typeof ASSETS)[number];

/** Price-feed id for an asset. The feed quotes against USDC on both networks. */
export const feedId = (asset: Asset): string => `${asset}/USDC`;

/**
 * The collateral token every Event Contract settles in.
 *
 * Bundled rather than read from the kit, for the same reason the kit bundles its
 * own: the readiness check has to be able to tell you that you have no
 * collateral *before* you have installed anything. Testnet's tUSDC exposes a
 * public `faucet(uint256)`, which is how a wallet funds itself.
 *
 * Verified against ec-core's address book, 2026-08-19. Override if a venue moves.
 */
export const COLLATERAL_TOKEN: Record<Network, string> = {
  testnet: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  mainnet: "0x0Ed782B8079529f7385c3eDA9fAf1EaA0DbC6a17",
};

/** Human name of the collateral, for messages a person reads. */
export const collateralName = (net: Network): string => (net === "mainnet" ? "USDso" : "tUSDC");
