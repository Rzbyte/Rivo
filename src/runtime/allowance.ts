// ERC-20 approval for the pool that escrows collateral.
//
// This module exists because of a gap the kit has on one side and not the other.
// `packages/core/src/execute.ts` — the SPOT path — calls
// `ensureAllowance(ctx, inputToken, p.pool, amount)` before every order.
// `packages/ec-core` has no equivalent anywhere: `grep -rn "approve\|allowance"`
// over it returns nothing. Neither does `@somnia-chain/markets-sdk`.
//
// So an event-contract order from a fresh wallet reverts with
// `placeBinaryOrder reverted: for an unknown reason`, which names nothing and
// suggests nothing. Confirmed by comparing two wallets: ours had 0 allowance to
// every candidate spender, while a wallet that had successfully traded held an
// UNLIMITED allowance to the POOL address specifically — not to the binary
// module, not to markets-core.
//
// Pools are recycled across successive windows rather than deployed per window,
// so the set of addresses needing approval is small and stable. One approval per
// pool, cached, is enough.

import { createPublicClient, createWalletClient, defineChain, http, maxUint256, type Account, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gasTokenName, networkOfChainId } from "../core/venue.js";

const ERC20 = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface AllowanceConfig {
  rpcUrl: string;
  chainId: number;
  token: Address;
  /**
   * The key to sign with, when Rivo holds one.
   *
   * Exactly one of `privateKey` and `account` is required. The split exists
   * because approval is a chain write like any other, and the whole point of the
   * Privy authority is that Rivo never holds key material — so this had to stop
   * being a key-shaped hole. A viem `Account` covers both: a local key produces
   * one, and so does a wallet whose signing happens inside somebody else's
   * enclave.
   */
  privateKey?: string;
  /** A pre-built signer. Anything with `signTransaction` — see src/signing/privy.ts. */
  account?: Account;
}

export class AllowanceManager {
  /** Pools already known to be approved this process. */
  private readonly approved = new Set<string>();
  private readonly account;
  private readonly pub;
  private readonly wallet;
  private readonly token: Address;

  constructor(cfg: AllowanceConfig) {
    this.token = cfg.token;
    if (!cfg.account && !cfg.privateKey) {
      throw new Error("AllowanceManager needs either an account or a private key to sign an approval");
    }
    this.account = cfg.account ?? privateKeyToAccount(cfg.privateKey as `0x${string}`);
    const chain = defineChain({
      id: cfg.chainId,
      name: `somnia-${cfg.chainId}`,
      // A third copy of the gas-token rule lived here as `chainId === 5031`.
      // venue.ts already owns it.
      nativeCurrency: { name: "Somnia", symbol: gasTokenName(networkOfChainId(cfg.chainId)), decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    this.pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(cfg.rpcUrl) });
  }

  get address(): Address {
    return this.account.address;
  }

  async allowanceFor(pool: Address): Promise<bigint> {
    return this.pub.readContract({
      address: this.token,
      abi: ERC20,
      functionName: "allowance",
      args: [this.account.address, pool],
    });
  }

  /**
   * Make sure `pool` can pull at least `need` collateral, approving if not.
   *
   * Approves the maximum rather than a multiple of the requirement. The kit's
   * spot path approves `amount * 8`, which is right when there is one long-lived
   * pool per pair; here a recycled pool sees an unbounded stream of windows, and
   * re-approving mid-series costs a transaction and a round trip at exactly the
   * moment an edge is disappearing. The venue's own active wallets hold
   * unlimited approvals for the same reason.
   *
   * Returns the transaction hash when it approved, or null when nothing was needed.
   */
  async ensure(pool: Address, need: bigint): Promise<string | null> {
    const key = pool.toLowerCase();
    if (this.approved.has(key)) return null;
    const current = await this.allowanceFor(pool);
    if (current >= need && current > 0n) {
      this.approved.add(key);
      return null;
    }
    const hash = await this.wallet.writeContract({
      address: this.token,
      abi: ERC20,
      functionName: "approve",
      args: [pool, maxUint256],
    });
    await this.pub.waitForTransactionReceipt({ hash });
    this.approved.add(key);
    return hash;
  }

  /** Forget a cached approval, so the next order re-checks it on-chain. */
  forget(pool: Address): void {
    this.approved.delete(pool.toLowerCase());
  }
}
