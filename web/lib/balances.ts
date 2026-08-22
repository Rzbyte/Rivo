// What the portfolio wallet actually holds.
//
// Read straight from the chain over JSON-RPC rather than through a wallet
// library, for the same reason `src/runtime/onchain.ts` does: it is two calls,
// it needs no signer, and it must work on a page where nothing else has loaded
// yet. A funding screen that cannot tell you your balance because a provider is
// still initialising is a funding screen nobody trusts.
//
// A failed read returns null, never zero. "We could not check" and "you have
// nothing" look identical to a user and mean opposite things — one is a reason
// to wait, the other is a reason to send money.

import { CHAIN, COLLATERAL, GAS_SYMBOL } from "./somnia";

export interface Balances {
  /** Native gas token, in whole units. Null when the read failed. */
  gas: number | null;
  /** DreamDEX collateral, in whole units. Null when the read failed. */
  collateral: number | null;
  gasSymbol: string;
  collateralSymbol: string;
}

const RPC = CHAIN.rpcUrls.default.http[0]!;

async function rpc(method: string, params: unknown[]): Promise<string | null> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: string };
    return typeof body.result === "string" ? body.result : null;
  } catch {
    return null;
  }
}

const whole = (hex: string | null, decimals: number): number | null =>
  hex === null ? null : Number(BigInt(hex)) / 10 ** decimals;

/** `balanceOf(address)` */
const BALANCE_OF = "0x70a08231";

export async function readBalances(address: string): Promise<Balances> {
  const [gasHex, collateralHex] = await Promise.all([
    rpc("eth_getBalance", [address, "latest"]),
    rpc("eth_call", [
      { to: COLLATERAL.address, data: BALANCE_OF + address.toLowerCase().replace(/^0x/, "").padStart(64, "0") },
      "latest",
    ]),
  ]);
  return {
    gas: whole(gasHex, 18),
    collateral: whole(collateralHex, COLLATERAL.decimals),
    gasSymbol: GAS_SYMBOL,
    collateralSymbol: COLLATERAL.symbol,
  };
}

/**
 * Whether a wallet can actually trade.
 *
 * Both are required and they fail differently, so they are reported separately.
 * No collateral means nothing to buy with. No gas means every transaction
 * reverts before it starts — including the approval, which is the first thing
 * Rivo sends and the one whose failure message names nothing useful.
 */
export function fundingGap(b: Balances, needCollateral: number): { collateral: boolean; gas: boolean } {
  return {
    collateral: b.collateral !== null && b.collateral < needCollateral,
    gas: b.gas !== null && b.gas < 0.01,
  };
}
