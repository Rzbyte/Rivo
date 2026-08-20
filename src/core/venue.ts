// Venue facts, with no runtime dependencies.
//
// Split out from config.ts so the browser can use them. config.ts layers `.env`
// overrides on top of these, which needs `node:fs` and therefore cannot be
// bundled; everything here is constants and pure functions, so the public page
// and the runtime read from ONE source rather than drifting copies.

export type Network = "testnet" | "mainnet";

export interface VenueEndpoints {
  /** Somnia Markets indexer — binary markets, orders, fills, oracle answers. */
  indexer: string;
  /** Oracle price-feed indexer — the UNDERLYING BTC/ETH spot, not a contract's own price. */
  priceFeed: string;
  /** The DreamDEX venue. These move; see .env.example. */
  venueId: string;
  rpc: string;
  /** Collateral decimals: 6 on testnet (tUSDC), 18 on mainnet (USDso). */
  decimals: number;
  chainId: number;
}

export const VENUE: Record<Network, VenueEndpoints> = {
  testnet: {
    indexer: "https://dev.smk.somnia.host/v1/graphql",
    priceFeed: "https://price-feed.dev.oracle.somnia.host/v1/graphql",
    venueId: "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c",
    rpc: "https://api.infra.testnet.somnia.network",
    decimals: 6,
    chainId: 50312,
  },
  mainnet: {
    indexer: "https://prd.smk.somnia.host/v1/graphql",
    // No bundled mainnet price feed yet — set RIVO_PRICE_FEED_URL there.
    priceFeed: "",
    venueId: "0x458b30c2d72bfd2c6317304a4594ecbafe5f729d3111b65fdc3a33bd48e5432d",
    rpc: "https://api.infra.mainnet.somnia.network",
    decimals: 18,
    chainId: 5031,
  },
};

/** The two underlyings the venue lists. Everything else derives from these. */
export const ASSETS = ["BTC", "ETH"] as const;
export type Asset = (typeof ASSETS)[number];

/** Price-feed id for an asset. The feed quotes against USDC on both networks. */
export const feedId = (asset: Asset): string => `${asset}/USDC`;

/**
 * The cadences DreamDEX actually lists: 15m, 1h, 4h, 1d.
 *
 * The indexer also carries retired series at 56-60s and ~5m from earlier venue
 * configurations. They are not the product and are excluded everywhere.
 */
export const TRADEABLE_CADENCES = [900, 3600, 14400, 86400] as const;

/** Series drift a second or two between windows, so match by proximity. */
export const matchesCadence = (actual: number, target: number): boolean =>
  Math.abs(actual - target) <= Math.max(2, target * 0.01);

/** Human tenor label: 900 -> "15m", 3600 -> "1h", 86400 -> "1d". */
export function tenorLabel(intervalSec: number): string {
  const m = Math.round(intervalSec / 60);
  return m >= 1440 ? `${Math.round(m / 1440)}d` : m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`;
}

/**
 * The collateral token every Event Contract settles in. Testnet's tUSDC exposes
 * a public `faucet(uint256)`. Verified against ec-core's address book 2026-08-19.
 */
export const COLLATERAL_TOKEN: Record<Network, string> = {
  testnet: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  mainnet: "0x0Ed782B8079529f7385c3eDA9fAf1EaA0DbC6a17",
};

export const collateralName = (net: Network): string => (net === "mainnet" ? "USDso" : "tUSDC");

/**
 * Put an oracle `numericValue` back into real price units.
 *
 * The scale is NOT declared anywhere and is NOT constant: opening references are
 * 1e2 while settlement answers are 1e4 (measured on testnet, 2026-08-19).
 * Reading a reference at the wrong scale is silent and catastrophic — it moves
 * the price by 100x, which turns every probability into 0 or 1 while still
 * looking like a plausible number.
 *
 * So we do not trust a constant. Pick the power of ten landing nearest a known
 * good price for the same asset, and reject the row when nothing lands close.
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
  // life. Beyond ~40% away means no scale fits and the row is unusable.
  return !best || best.err > 0.35 ? null : best.value;
}
