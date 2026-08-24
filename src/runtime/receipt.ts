// Ask the chain what happened to a transaction.
//
// Dependency-free JSON-RPC, for the same reason `onchain.ts` is: this runs on
// the recovery path of a process that may have no signer, no kit and no wallet
// library loaded, and the one thing it must never do is fail to load.
//
// The three-way return is the whole design. `null` means "we could not find
// out", and it is emphatically NOT "not mined" — an RPC that is down, rate
// limited or lagging returns exactly the same shape as a transaction that was
// never sent, and treating those alike is how recovery decides to re-send an
// order that already filled.

import { timeoutSignal } from "../core/timeout.js";
// venue.js is constants and pure functions with no imports of its own, so it
// does not cost this module the property described above.
import { rpcUrl, type Network } from "../core/venue.js";

export interface Receipt {
  /** True when the transaction succeeded on-chain. */
  ok: boolean;
  blockNumber: number;
  gasUsed?: number;
}

export interface ReceiptReader {
  /** The receipt, `null` when it is not yet known or could not be read. */
  receipt(txHash: string): Promise<Receipt | null>;
}

export class RpcReceiptReader implements ReceiptReader {
  constructor(
    private readonly rpcUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async receipt(txHash: string): Promise<Receipt | null> {
    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
        signal: timeoutSignal(this.timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: { status?: string; blockNumber?: string; gasUsed?: string } | null };
      const r = body.result;
      if (!r || typeof r.status !== "string" || typeof r.blockNumber !== "string") return null;
      return {
        ok: BigInt(r.status) === 1n,
        blockNumber: Number(BigInt(r.blockNumber)),
        ...(r.gasUsed ? { gasUsed: Number(BigInt(r.gasUsed)) } : {}),
      };
    } catch {
      return null;
    }
  }
}

/** The RPC this network uses, unless RPC_URL says otherwise. */
export const defaultRpcUrl = (network: Network): string => rpcUrl(network, process.env.RPC_URL);
