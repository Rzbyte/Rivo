// Somnia, as the wallet layer needs to see it.
//
// Every fact here comes from `src/core/venue.ts`, which exists precisely so
// there is ONE definition of the chain, its collateral and its explorer. That
// file has no runtime dependencies so it can be bundled into a browser, and this
// module's only job is to reshape what it already knows into the `Chain` object
// viem and Privy want.
//
// Restating a chain id, a token address or an RPC here would be the cheapest
// possible bug: these move — the venue id changed three times in one week — and
// a second copy is a second thing that has to be remembered.

import type { Chain } from "viem";
import { COLLATERAL_TOKEN, VENUE, addressUrl, collateralName, gasTokenName, txUrl, type Network } from "@rivo/core/venue.js";

export const NETWORK: Network = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") === "mainnet" ? "mainnet" : "testnet";

function chainOf(net: Network): Chain {
  const v = VENUE[net];
  return {
    id: v.chainId,
    name: v.chainName,
    nativeCurrency: { name: gasTokenName(net), symbol: gasTokenName(net), decimals: 18 },
    rpcUrls: { default: { http: [v.rpc] } },
    blockExplorers: { default: { name: "Somnia Explorer", url: v.explorer } },
    ...(net === "testnet" ? { testnet: true } : {}),
  };
}

export const SOMNIA_TESTNET = chainOf("testnet");
export const SOMNIA_MAINNET = chainOf("mainnet");
export const CHAIN = chainOf(NETWORK);

/** The collateral this venue trades in. */
export const COLLATERAL = {
  address: COLLATERAL_TOKEN[NETWORK] as `0x${string}`,
  symbol: collateralName(NETWORK),
  decimals: VENUE[NETWORK].decimals,
};

export const GAS_SYMBOL = gasTokenName(NETWORK);
export const explorerTx = (hash: string): string => txUrl(NETWORK, hash);
export const explorerAddress = (address: string): string => addressUrl(NETWORK, address);
